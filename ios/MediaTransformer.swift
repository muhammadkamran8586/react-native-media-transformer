@preconcurrency import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin
import NitroModules

final class MediaTransformer: HybridMediaTransformerSpec, @unchecked Sendable {
    // Reader/writer state and promise settlement always run on this queue.
    private let queue = DispatchQueue(label: "MediaTransformer.compression", qos: .userInitiated)
    private var currentJob: CompressionJob?

    deinit {
        if let job = currentJob {
            job.loadingTask?.cancel()
            job.reader?.cancelReading()
            if let writer = job.writer, writer.status == .writing {
                writer.cancelWriting()
            }
            if let outputURL = job.outputURL {
                try? FileManager.default.removeItem(at: outputURL)
            }
            job.promise.reject(withError: Self.error("Compression was cancelled because the transformer was released"))
        }
    }

    public func compress(
        inputUri: String,
        options: NativeCompressOptions,
        onProgress: ((_ progress: Double) -> Void)?
    ) throws -> Promise<String> {
        let promise = Promise<String>()
        queue.async {
            if let previous = self.currentJob {
                self.fail(previous, with: Self.error("Compression was cancelled by a new request"))
            }

            let job = CompressionJob(promise: promise, onProgress: onProgress)
            self.currentJob = job
            do {
                try Self.validate(options)
                let inputURL = try Self.inputURL(inputUri)
                let outputURL = try Self.outputURL(name: options.outputFileName, extension: "mp4", input: inputURL, overwrite: options.overwrite ?? false)
                job.finalURL = outputURL
                job.overwrite = options.overwrite ?? false

                // Load metadata asynchronously so cancellation can also interrupt preparation.
                let asset = AVURLAsset(url: inputURL)
                job.loadingTask = Task {
                    do {
                        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
                            throw Self.error("Input does not contain a video track")
                        }
                        let audio = try await asset.loadTracks(withMediaType: .audio)
                        let size = try await video.load(.naturalSize)
                        let transform = try await video.load(.preferredTransform)
                        let dataRate = try await video.load(.estimatedDataRate)
                        let duration = try await asset.load(.duration)
                        try Task.checkCancellation()
                        self.queue.async {
                            guard self.currentJob === job else { return }
                            job.loadingTask = nil
                            do {
                                try self.start(
                                    job, asset: asset, video: video, audio: audio,
                                    size: size, transform: transform, dataRate: dataRate,
                                    duration: duration, outputURL: outputURL, options: options
                                )
                            } catch {
                                self.fail(job, with: error)
                            }
                        }
                    } catch {
                        self.queue.async { self.fail(job, with: error) }
                    }
                }
            } catch {
                self.fail(job, with: error)
            }
        }
        return promise
    }

    public func cancelCompress() throws -> Promise<Void> {
        let promise = Promise<Void>()
        queue.async {
            if let job = self.currentJob {
                self.fail(job, with: Self.error("Compression was cancelled by user"))
            }
            promise.resolve()
        }
        return promise
    }

    private func start(
        _ job: CompressionJob,
        asset: AVAsset,
        video: AVAssetTrack,
        audio: [AVAssetTrack],
        size: CGSize,
        transform: CGAffineTransform,
        dataRate: Float,
        duration: CMTime,
        outputURL: URL,
        options: NativeCompressOptions
    ) throws {
        let displayedSize = CGRect(origin: .zero, size: size).applying(transform).size
        let displayedHeight = abs(displayedSize.height)
        guard size.width.isFinite, size.height.isFinite,
              size.width >= 2, size.height >= 2,
              displayedHeight.isFinite, displayedHeight > 0,
              duration.seconds.isFinite, duration.seconds > 0 else {
            throw Self.error("Input video has invalid dimensions or duration")
        }
        let displayedWidth = abs(displayedSize.width)
        let scale = min(1, (options.maxHeight ?? Double(displayedHeight)) / Double(displayedHeight),
                        (options.maxWidth ?? Double(displayedWidth)) / Double(displayedWidth))
        let start = options.startTime ?? 0
        let end = min(options.endTime ?? duration.seconds, duration.seconds)
        guard start < end else { throw Self.error("startTime must be before the end of the input video") }
        job.endTime = CMTime(seconds: end, preferredTimescale: 60000)
        // H.264 requires even dimensions. maxHeight never enlarges smaller inputs.
        let width = max(2, Int((Double(size.width) * scale / 2).rounded(.down)) * 2)
        let height = max(2, Int((Double(size.height) * scale / 2).rounded(.down)) * 2)
        let defaultBitrate = min(
            dataRate.isFinite && dataRate > 0 ? Double(dataRate) : 2_000_000,
            max(250_000, Double(width) * Double(height) * 4)
        )
        var compressionProperties: [String: Any] = [AVVideoAverageBitRateKey: Int(options.bitrate ?? defaultBitrate)]
        if options.codec != .hevc { compressionProperties[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        if let fps = options.maxFrameRate { compressionProperties[AVVideoExpectedSourceFrameRateKey] = fps }
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: options.codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
            AVVideoCompressionPropertiesKey: compressionProperties,
        ]

        let reader = try AVAssetReader(asset: asset)
        job.reader = reader
        reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 60000),
                                       end: job.endTime)
        let videoOutput = AVAssetReaderTrackOutput(track: video, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        videoOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOutput) else {
            throw Self.error("Cannot read the input video track")
        }
        reader.add(videoOutput)

        let temporaryURL = outputURL.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).mp4")
        job.outputURL = temporaryURL
        let writer = try AVAssetWriter(outputURL: temporaryURL, fileType: .mp4)
        job.writer = writer
        writer.shouldOptimizeForNetworkUse = options.optimizeForNetworkUse ?? true
        guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
            throw Self.error("Video compression settings are not supported")
        }
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        // Keep rotation/mirroring metadata and normalize bounds for the encoded size.
        var outputTransform = transform
        let bounds = CGRect(x: 0, y: 0, width: width, height: height).applying(outputTransform)
        outputTransform.tx -= bounds.minX
        outputTransform.ty -= bounds.minY
        videoInput.transform = outputTransform
        guard writer.canAdd(videoInput) else {
            throw Self.error("Cannot write the compressed video track")
        }
        writer.add(videoInput)

        var streams = [CompressionStream(output: videoOutput, input: videoInput)]
        if !audio.isEmpty && options.mute != true {
            let audioOutput = AVAssetReaderAudioMixOutput(audioTracks: audio, audioSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: options.audioSampleRate ?? 44_100,
                AVNumberOfChannelsKey: Int(options.audioChannels ?? 2),
            ])
            audioOutput.alwaysCopiesSampleData = false
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: options.audioSampleRate ?? 44_100,
                AVNumberOfChannelsKey: Int(options.audioChannels ?? 2),
                AVEncoderBitRateKey: Int(options.audioBitrate ?? 128_000),
            ]
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            guard reader.canAdd(audioOutput),
                  writer.canApply(outputSettings: audioSettings, forMediaType: .audio),
                  writer.canAdd(audioInput) else {
                throw Self.error("Cannot preserve the input audio")
            }
            reader.add(audioOutput)
            writer.add(audioInput)
            streams.append(CompressionStream(output: audioOutput, input: audioInput))
        }

        guard writer.startWriting() else {
            throw writer.error ?? Self.error("Could not start writing the compressed video")
        }
        writer.startSession(atSourceTime: reader.timeRange.start)
        guard reader.startReading() else {
            throw reader.error ?? Self.error("Could not start reading the input video")
        }
        job.remainingStreams = streams.count
        job.onProgress?(0)
        for stream in streams {
            stream.input.requestMediaDataWhenReady(on: queue) { [weak self, weak job] in
                guard let self, let job, self.currentJob === job,
                      let reader = job.reader, let writer = job.writer else { return }
                let input = stream.input
                let output = stream.output
                while input.isReadyForMoreMediaData {
                    let keepReading: Bool = autoreleasepool {
                        guard let sample = output.copyNextSampleBuffer() else {
                            if reader.status == .failed {
                                self.fail(job, with: reader.error ?? Self.error("Failed to read the input video"))
                            } else {
                                input.markAsFinished()
                                job.remainingStreams -= 1
                                if job.remainingStreams == 0 {
                                    self.finish(job)
                                }
                            }
                            return false
                        }
                        let timestamp = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                        if input.mediaType == .video, let fps = options.maxFrameRate {
                            if timestamp + 0.000001 < job.nextVideoTime { return true }
                            let elapsed = max(0, timestamp - start)
                            job.nextVideoTime = start + (floor(elapsed * fps + 0.000001) + 1) / fps
                        }
                        guard input.append(sample) else {
                            self.fail(job, with: writer.error ?? Self.error("Failed to encode the video"))
                            return false
                        }
                        if input.mediaType == .video {
                            job.hasVideoSamples = true
                            let progress = (timestamp - start) / (end - start)
                            let now = ProcessInfo.processInfo.systemUptime
                            if progress.isFinite, now - job.lastProgressTime >= (options.progressInterval ?? 300) / 1000 {
                                job.lastProgressTime = now
                                job.onProgress?(min(0.99, max(0, progress)))
                            }
                        }
                        return true
                    }
                    if !keepReading { return }
                }
            }
        }
    }

    private func finish(_ job: CompressionJob) {
        guard job.hasVideoSamples, let writer = job.writer else {
            fail(job, with: Self.error("Input video contains no readable frames"))
            return
        }
        writer.endSession(atSourceTime: job.endTime)
        writer.finishWriting { [weak self, weak job] in
            guard let self, let job else { return }
            self.queue.async {
                guard self.currentJob === job, let writer = job.writer else { return }
                guard writer.status == .completed, let outputURL = job.outputURL else {
                    self.fail(job, with: writer.error ?? Self.error("Could not finish the compressed video"))
                    return
                }
                do {
                    guard let finalURL = job.finalURL else { throw Self.error("Missing output destination") }
                    try Self.publish(temporary: outputURL, destination: finalURL, overwrite: job.overwrite)
                    self.currentJob = nil
                    job.onProgress?(1)
                    job.promise.resolve(withResult: finalURL.path)
                } catch { self.fail(job, with: error) }
            }
        }
    }

    private func fail(_ job: CompressionJob, with error: Error) {
        // Late callbacks must never settle twice or remove a newer job's output.
        guard currentJob === job else { return }
        currentJob = nil
        job.loadingTask?.cancel()
        job.loadingTask = nil
        job.reader?.cancelReading()
        if let writer = job.writer, writer.status == .writing {
            writer.cancelWriting()
        }
        if let outputURL = job.outputURL {
            try? FileManager.default.removeItem(at: outputURL)
        }
        job.promise.reject(withError: error)
    }

    public func getVideoMetadata(inputUri: String) throws -> Promise<VideoMetadata> {
        return Promise.async {
            let url = try Self.inputURL(inputUri)
            let asset = AVURLAsset(url: url)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Self.error("Input does not contain a video track") }
            let size = try await track.load(.naturalSize)
            let transform = try await track.load(.preferredTransform)
            let displayed = CGRect(origin: .zero, size: size).applying(transform).size
            let duration = try await asset.load(.duration).seconds
            let bitrate = try await track.load(.estimatedDataRate)
            let fps = try await track.load(.nominalFrameRate)
            let hasAudio = try await !asset.loadTracks(withMediaType: .audio).isEmpty
            let bytes = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.doubleValue ?? 0
            let rotation = (atan2(transform.b, transform.a) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
            return VideoMetadata(width: abs(displayed.width), height: abs(displayed.height), duration: duration,
                                 size: bytes, bitrate: Double(bitrate), frameRate: Double(fps), hasAudio: hasAudio, rotation: rotation)
        }
    }

    public func createThumbnail(inputUri: String, options: ThumbnailOptions) throws -> Promise<ThumbnailResult> {
        return Promise.async {
            try Self.range("time", options.time, 0, 2147483)
            try Self.range("quality", options.quality, 0, 1)
            try Self.range("maxWidth", options.maxWidth, 2, 16384, integer: true)
            try Self.range("maxHeight", options.maxHeight, 2, 16384, integer: true)
            let input = try Self.inputURL(inputUri)
            let asset = AVURLAsset(url: input)
            let duration = try await asset.load(.duration).seconds
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw Self.error("Input does not contain a video track") }
            let size = try await track.load(.naturalSize)
            let transform = try await track.load(.preferredTransform)
            let displayed = CGRect(origin: .zero, size: size).applying(transform).size
            let time = options.time ?? 0
            guard time < duration else { throw Self.error("Thumbnail time must be before the end of the video") }
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            let scale = min(1, (options.maxWidth ?? abs(displayed.width)) / abs(displayed.width),
                            (options.maxHeight ?? abs(displayed.height)) / abs(displayed.height))
            generator.maximumSize = CGSize(width: abs(displayed.width) * scale, height: abs(displayed.height) * scale)
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            // The synchronous AVFoundation call runs on this Task's background executor.
            let image = try generator.copyCGImage(at: CMTime(seconds: time, preferredTimescale: 60000), actualTime: nil)
            let output = try Self.outputURL(name: options.outputFileName, extension: "jpg", input: input, overwrite: options.overwrite ?? false)
            let temporary = output.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).jpg")
            defer { try? FileManager.default.removeItem(at: temporary) }
            guard let destination = CGImageDestinationCreateWithURL(temporary as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw Self.error("Could not create thumbnail") }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: options.quality ?? 0.8] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw Self.error("Could not write thumbnail") }
            try Self.publish(temporary: temporary, destination: output, overwrite: options.overwrite ?? false)
            return ThumbnailResult(path: output.path, width: Double(image.width), height: Double(image.height))
        }
    }

    private static func inputURL(_ uri: String) throws -> URL {
        let url: URL
        if uri.hasPrefix("/") { url = URL(fileURLWithPath: uri) }
        else if let value = URL(string: uri), value.isFileURL { url = value }
        else { throw error("Input must be an absolute file path or file:// URL") }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue,
              FileManager.default.isReadableFile(atPath: url.path) else { throw error("Input video does not exist or is not readable") }
        return url
    }

    private static func outputURL(name: String?, extension ext: String, input: URL, overwrite: Bool) throws -> URL {
        let name = name ?? "media_\(UUID().uuidString).\(ext)"
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !name.contains("/"), !name.contains("\\"),
              !name.unicodeScalars.contains(where: { $0.value < 32 }), name.lowercased().hasSuffix(".\(ext)") else {
            throw error("outputFileName must be a filename ending in .\(ext) without directory components")
        }
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("media-transformer", isDirectory: true)
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        let output = cache.appendingPathComponent(name)
        guard input.resolvingSymlinksInPath().standardizedFileURL != output.resolvingSymlinksInPath().standardizedFileURL else { throw error("Output file must be different from the input video") }
        try checkDestination(output, overwrite: overwrite)
        return output
    }

    private static func checkDestination(_ output: URL, overwrite: Bool) throws {
        let attributes = try? FileManager.default.attributesOfItem(atPath: output.path)
        if let attributes {
            guard attributes[.type] as? FileAttributeType == .typeRegular else { throw error("Output must be a regular file, not a directory or symbolic link") }
            guard overwrite else { throw error("Output file already exists; set overwrite to true to replace it") }
        }
    }

    private static func publish(temporary: URL, destination: URL, overwrite: Bool) throws {
        try checkDestination(destination, overwrite: overwrite)
        if overwrite {
            guard rename(temporary.path, destination.path) == 0 else { throw error("Could not replace output file") }
        } else {
            // An atomic no-clobber publish, including races between module instances.
            try FileManager.default.linkItem(at: temporary, to: destination)
            try? FileManager.default.removeItem(at: temporary)
        }
    }

    private static func range(_ name: String, _ value: Double?, _ min: Double, _ max: Double, integer: Bool = false) throws {
        if let value, !value.isFinite || value < min || value > max || (integer && value.rounded() != value) {
            throw error("\(name) must be \(integer ? "an integer" : "a finite number") between \(min) and \(max)")
        }
    }

    private static func validate(_ options: NativeCompressOptions) throws {
        try range("maxWidth", options.maxWidth, 2, 16384, integer: true)
        try range("maxHeight", options.maxHeight, 2, 16384, integer: true)
        try range("bitrate", options.bitrate, 1, Double(Int32.max), integer: true)
        try range("maxFrameRate", options.maxFrameRate, 1, 240)
        try range("startTime", options.startTime, 0, 2147483)
        try range("endTime", options.endTime, 0, 2147483)
        if let end = options.endTime, end <= (options.startTime ?? 0) { throw error("endTime must be greater than startTime") }
        try range("audioBitrate", options.audioBitrate, 8000, 320000, integer: true)
        try range("audioChannels", options.audioChannels, 1, 2, integer: true)
        if let rate = options.audioSampleRate, ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].contains(rate) { throw error("audioSampleRate must be a supported AAC sample rate") }
        try range("progressInterval", options.progressInterval, 50, 10000, integer: true)
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "MediaTransformer", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

// Mutable members are confined to MediaTransformer.queue.
private final class CompressionJob: @unchecked Sendable {
    let promise: Promise<String>
    let onProgress: ((Double) -> Void)?
    var loadingTask: Task<Void, Never>?
    var reader: AVAssetReader?
    var writer: AVAssetWriter?
    var outputURL: URL?
    var finalURL: URL?
    var overwrite = false
    var endTime = CMTime.zero
    var nextVideoTime = -Double.infinity
    var remainingStreams = 0
    var hasVideoSamples = false
    var lastProgressTime: TimeInterval = 0

    init(promise: Promise<String>, onProgress: ((Double) -> Void)?) {
        self.promise = promise
        self.onProgress = onProgress
    }
}

// Both endpoints are accessed only from MediaTransformer.queue.
private struct CompressionStream: @unchecked Sendable {
    let output: AVAssetReaderOutput
    let input: AVAssetWriterInput
}
