@preconcurrency import AVFoundation
import Foundation
import ImageIO
import NitroModules

private func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() {
        throw NSError(domain: "CompressionTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private func expectFailure(_ promise: Promise<String>, containing message: String? = nil) async throws {
    do {
        _ = try await promise.await()
    } catch {
        if let message {
            try check(error.localizedDescription.contains(message), "Unexpected error: \(error)")
        }
        return
    }
    try check(false, "Expected compression to fail")
}

private func fixture(at url: URL, rotated: Bool = false) async throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: 384,
        AVVideoHeightKey: 216,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000],
    ])
    if rotated {
        input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 216, ty: 0)
    }
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
        kCVPixelBufferWidthKey as String: 384,
        kCVPixelBufferHeightKey as String: 216,
    ])
    writer.add(input)
    try check(writer.startWriting(), "Fixture writer failed: \(String(describing: writer.error))")
    writer.startSession(atSourceTime: .zero)
    var random: UInt32 = 42
    for frame in 0..<90 {
        while !input.isReadyForMoreMediaData {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        var buffer: CVPixelBuffer?
        try check(CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer) == kCVReturnSuccess,
                  "Could not allocate a fixture frame")
        CVPixelBufferLockBaseAddress(buffer!, [])
        let bytes = CVPixelBufferGetBaseAddress(buffer!)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer!)
        for y in 0..<216 {
            for x in 0..<384 {
                random = random &* 1_664_525 &+ 1_013_904_223
                let offset = y * stride + x * 4
                bytes[offset] = 255
                bytes[offset + 1] = UInt8(truncatingIfNeeded: random >> 24)
                bytes[offset + 2] = UInt8(truncatingIfNeeded: x + frame * 3)
                bytes[offset + 3] = UInt8(truncatingIfNeeded: y + frame * 2)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer!, [])
        try check(adaptor.append(buffer!, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)),
                  "Could not append fixture frame")
    }
    input.markAsFinished()
    await writer.finishWriting()
    try check(writer.status == .completed, "Fixture failed: \(String(describing: writer.error))")
}

private func addAudio(to videoURL: URL, in directory: URL) async throws -> URL {
    let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 132_300)!
    buffer.frameLength = buffer.frameCapacity
    for i in 0..<Int(buffer.frameLength) {
        buffer.floatChannelData![0][i] = Float(sin(Double(i) * 2 * .pi * 440 / 44_100)) * 0.2
    }
    let audioURL = directory.appendingPathComponent("tone.caf")
    let file = try AVAudioFile(forWriting: audioURL, settings: format.settings)
    try file.write(from: buffer)
    let composition = AVMutableComposition()
    let videoAsset = AVURLAsset(url: videoURL)
    let audioAsset = AVURLAsset(url: audioURL)
    let videoTrack = try await videoAsset.loadTracks(withMediaType: .video)[0]
    let audioTrack = try await audioAsset.loadTracks(withMediaType: .audio)[0]
    let duration = try await videoAsset.load(.duration)
    let range = CMTimeRange(start: .zero, duration: duration)
    try composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
        .insertTimeRange(range, of: videoTrack, at: .zero)
    try composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
        .insertTimeRange(range, of: audioTrack, at: .zero)
    let output = directory.appendingPathComponent("with-audio.mov")
    let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough)!
    export.outputURL = output
    export.outputFileType = .mov
    await export.export()
    try check(export.status == .completed, "Audio fixture failed: \(String(describing: export.error))")
    return output
}

private func inspect(_ path: String, height expectedHeight: Double, audio: Bool, duration expectedDuration: Double = 3, frames expectedFrames: Int = 90, codec: CMVideoCodecType = kCMVideoCodecType_H264) async throws -> Int {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let tracks = try await asset.loadTracks(withMediaType: .video)
    try check(tracks.count == 1, "Output must have one video track")
    let size = try await tracks[0].load(.naturalSize)
    let transform = try await tracks[0].load(.preferredTransform)
    let displayed = size.applying(transform)
    try check(abs(abs(displayed.height) - expectedHeight) <= 2, "Wrong displayed height: \(displayed)")
    let descriptions = try await tracks[0].load(.formatDescriptions)
    try check(CMFormatDescriptionGetMediaSubType(descriptions[0]) == codec, "Output codec is incorrect")
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    try check(audioTracks.isEmpty != audio, "Output audio presence is incorrect")
    if audio {
        let audioDescriptions = try await audioTracks[0].load(.formatDescriptions)
        try check(CMFormatDescriptionGetMediaSubType(audioDescriptions[0]) == kAudioFormatMPEG4AAC, "Output must use AAC audio")
    }
    let duration = try await asset.load(.duration)
    try check(abs(duration.seconds - expectedDuration) < 0.15, "Output duration changed: \(duration.seconds)")
    // Actually decode every output frame, rather than only checking metadata.
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: tracks[0], outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ])
    reader.add(output)
    try check(reader.startReading(), "Could not decode compressed output")
    var count = 0
    while autoreleasepool(invoking: { output.copyNextSampleBuffer() != nil }) { count += 1 }
    try check(reader.status == .completed && count == expectedFrames, "Compressed frames are missing: \(count)")
    return (try FileManager.default.attributesOfItem(atPath: path)[.size] as! NSNumber).intValue
}

@main
private struct CompressionTests {
    static func main() async {
        do {
            try await run()
        } catch {
            FileHandle.standardError.write(Data("FAIL: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    static func run() async throws {
        // A hung promise or encoder must fail the run instead of waiting forever.
        DispatchQueue.global().asyncAfter(deadline: .now() + 90) {
            FileHandle.standardError.write(Data("FAIL: native tests timed out\n".utf8))
            exit(1)
        }
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("media-transformer")
        try check(cache.resolvingSymlinksInPath().path.hasPrefix(directory.resolvingSymlinksInPath().path),
                  "Test cache \(cache.path) must be inside the temporary test directory \(directory.path)")
        let source = directory.appendingPathComponent("source video.mov")
        try await fixture(at: source)
        let transformer = MediaTransformer()
        var progress: [Double] = []
        let result = try await transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(maxHeight: 108, bitrate: 150_000, outputFileName: "compressed.mp4"),
            onProgress: { progress.append($0) }).await()
        try check(URL(fileURLWithPath: result).lastPathComponent == "compressed.mp4", "Custom filename was ignored")
        let smallBytes = try await inspect(result, height: 108, audio: false)
        try check(progress.first == 0 && progress.last == 1, "Progress must start at zero and finish at one")
        try check(progress.allSatisfy { (0...1).contains($0) }, "Progress is outside 0...1")
        try check(zip(progress, progress.dropFirst()).allSatisfy { $0 <= $1 }, "Progress decreased")
        print("PASS: path input, height, filename, H.264, decoded frames, duration, progress")

        let larger = try await transformer.compress(inputUri: source.absoluteString,
            options: NativeCompressOptions(maxHeight: 108, bitrate: 900_000), onProgress: nil).await()
        let largerBytes = try await inspect(larger, height: 108, audio: false)
        try check(largerBytes > smallBytes, "Explicit bitrate did not affect compression")
        print("PASS: file URL with spaces, optional callback, unique filename, bitrate")

        let unscaled = try await transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(maxHeight: 720), onProgress: nil).await()
        _ = try await inspect(unscaled, height: 216, audio: false)
        print("PASS: maxHeight does not upscale smaller video")

        let rotated = directory.appendingPathComponent("portrait.mov")
        try await fixture(at: rotated, rotated: true)
        let portrait = try await transformer.compress(inputUri: rotated.path,
            options: NativeCompressOptions(maxHeight: 192), onProgress: nil).await()
        _ = try await inspect(portrait, height: 192, audio: false)
        let portraitTrack = try await AVURLAsset(url: URL(fileURLWithPath: portrait)).loadTracks(withMediaType: .video)[0]
        let portraitTransform = try await portraitTrack.load(.preferredTransform)
        try check(abs(portraitTransform.b - 1) < 0.01 && abs(portraitTransform.c + 1) < 0.01, "Portrait rotation was lost")
        print("PASS: portrait orientation and displayed height")

        let withAudio = try await addAudio(to: source, in: directory)
        let audioResult = try await transformer.compress(inputUri: withAudio.path,
            options: NativeCompressOptions(maxHeight: 108), onProgress: nil).await()
        _ = try await inspect(audioResult, height: 108, audio: true)
        print("PASS: PCM source audio converted to AAC and video retained")

        let metadata = try await transformer.getVideoMetadata(inputUri: withAudio.path).await()
        try check(metadata.width == 384 && metadata.height == 216 && metadata.hasAudio && metadata.size > 0,
                  "Metadata dimensions, audio or size incorrect")
        try check(abs(metadata.duration - 3) < 0.1 && abs(metadata.frameRate - 30) < 0.1, "Metadata timing incorrect")
        let rotatedMetadata = try await transformer.getVideoMetadata(inputUri: rotated.path).await()
        try check(rotatedMetadata.width == 216 && rotatedMetadata.height == 384 && abs(rotatedMetadata.rotation - 90) < 0.1, "Rotated metadata incorrect")
        print("PASS: metadata, displayed dimensions, frame rate, file size and orientation")

        let bounded = try await transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(maxWidth: 192, maxHeight: 200), onProgress: nil).await()
        _ = try await inspect(bounded, height: 108, audio: false)
        let trimmed = try await transformer.compress(inputUri: withAudio.path,
            options: NativeCompressOptions(maxWidth: 192, maxFrameRate: 15, startTime: 1, endTime: 2, mute: true), onProgress: nil).await()
        _ = try await inspect(trimmed, height: 108, audio: false, duration: 1, frames: 15)
        print("PASS: width/height bounding box, nonzero trim, frame rate cap and mute")

        let tunedAudio = try await transformer.compress(inputUri: withAudio.path,
            options: NativeCompressOptions(audioBitrate: 96000, audioSampleRate: 48000, audioChannels: 1), onProgress: nil).await()
        _ = try await inspect(tunedAudio, height: 216, audio: true)
        if let fixturePath = ProcessInfo.processInfo.environment["MEDIA_TRANSFORMER_FIXTURE_PATH"] {
            try FileManager.default.copyItem(at: URL(fileURLWithPath: tunedAudio), to: URL(fileURLWithPath: fixturePath))
        }
        let tunedTrack = try await AVURLAsset(url: URL(fileURLWithPath: tunedAudio)).loadTracks(withMediaType: .audio)[0]
        let audioFormat = try await tunedTrack.load(.formatDescriptions)[0]
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(audioFormat)!.pointee
        try check(asbd.mSampleRate == 48000 && asbd.mChannelsPerFrame == 1, "Audio controls ignored")
        print("PASS: AAC sample rate, mono channel conversion and bitrate option")

        let hevc = try await transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(codec: .hevc), onProgress: nil).await()
        _ = try await inspect(hevc, height: 216, audio: false, codec: kCMVideoCodecType_HEVC)
        print("PASS: HEVC encoding and decoded frames")

        let thumbnail = try await transformer.createThumbnail(inputUri: rotated.path,
            options: ThumbnailOptions(time: 1, maxWidth: 100, maxHeight: 100, quality: 0.6)).await()
        try check(thumbnail.width <= 100 && thumbnail.height <= 100 && thumbnail.height > thumbnail.width, "Thumbnail sizing/orientation incorrect")
        let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: thumbnail.path) as CFURL, nil)!
        let image = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)!
        try check(Double(image.width) == thumbnail.width && Double(image.height) == thumbnail.height, "Thumbnail result does not match decoded JPEG")
        do {
            _ = try await transformer.createThumbnail(inputUri: source.path, options: ThumbnailOptions(time: 4)).await()
            try check(false, "Out-of-range thumbnail should fail")
        } catch { try check(error.localizedDescription.contains("before the end"), "Wrong thumbnail error") }
        print("PASS: JPEG thumbnail decode, dimensions, rotation and timestamp validation")

        let originalBytes = try Data(contentsOf: URL(fileURLWithPath: result))
        try await expectFailure(transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(outputFileName: "compressed.mp4"), onProgress: nil), containing: "already exists")
        try check(try Data(contentsOf: URL(fileURLWithPath: result)) == originalBytes, "Existing output was modified")
        // Even explicit overwrite must not destroy an existing file on a failed export.
        try await expectFailure(transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(startTime: 4, outputFileName: "compressed.mp4", overwrite: true), onProgress: nil))
        try check(try Data(contentsOf: URL(fileURLWithPath: result)) == originalBytes, "Failed overwrite destroyed the old output")
        _ = try await transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(maxHeight: 108, outputFileName: "compressed.mp4", overwrite: true), onProgress: nil).await()
        print("PASS: no-clobber default, successful overwrite and failed overwrite preservation")

        for options in [NativeCompressOptions(maxHeight: .nan), NativeCompressOptions(maxHeight: 0),
                        NativeCompressOptions(bitrate: .infinity), NativeCompressOptions(bitrate: -1),
                        NativeCompressOptions(outputFileName: "../bad.mp4"),
                        NativeCompressOptions(maxWidth: 1), NativeCompressOptions(maxFrameRate: 0),
                        NativeCompressOptions(startTime: 2, endTime: 1), NativeCompressOptions(audioChannels: 3),
                        NativeCompressOptions(audioSampleRate: 12345), NativeCompressOptions(progressInterval: 0)] {
            let promise = try transformer.compress(inputUri: source.path, options: options, onProgress: nil)
            try await expectFailure(promise)
        }
        try await expectFailure(transformer.compress(inputUri: "/missing.mov", options: NativeCompressOptions(), onProgress: nil), containing: "not readable")
        try await expectFailure(transformer.compress(inputUri: "ph://123", options: NativeCompressOptions(), onProgress: nil), containing: "file://")
        try await expectFailure(transformer.compress(inputUri: result, options: NativeCompressOptions(outputFileName: "compressed.mp4"), onProgress: nil), containing: "different")
        try check(FileManager.default.fileExists(atPath: result), "Input was deleted by an output collision")
        let invalid = directory.appendingPathComponent("invalid.mov")
        try Data("invalid video".utf8).write(to: invalid)
        let invalidPromise = try transformer.compress(inputUri: invalid.path,
            options: NativeCompressOptions(outputFileName: "failed.mp4"), onProgress: nil)
        try await expectFailure(invalidPromise)
        try check(!FileManager.default.fileExists(atPath: cache.appendingPathComponent("failed.mp4").path), "Failure left output behind")
        print("PASS: invalid options, missing/invalid input, unsupported URI, input overwrite protection")

        let cancelled = try transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(outputFileName: "cancelled.mp4"), onProgress: nil)
        try await transformer.cancelCompress().await()
        try await expectFailure(cancelled, containing: "cancelled")
        try check(!FileManager.default.fileExists(atPath: cache.appendingPathComponent("cancelled.mp4").path), "Cancellation left output behind")
        // Cancel from progress to exercise cancellation after reader/writer startup.
        let midstream = try transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(outputFileName: "midstream.mp4"), onProgress: { p in
                if p == 0 { _ = try? transformer.cancelCompress() }
            })
        try await expectFailure(midstream, containing: "cancelled")
        try check(!FileManager.default.fileExists(atPath: cache.appendingPathComponent("midstream.mp4").path), "Midstream cancellation left output behind")
        try await transformer.cancelCompress().await()
        print("PASS: preparation/midstream/idle cancellation and partial file cleanup")

        let previous = try transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(outputFileName: "replacement.mp4"), onProgress: nil)
        let replacement = try transformer.compress(inputUri: source.path,
            options: NativeCompressOptions(outputFileName: "replacement.mp4"), onProgress: nil)
        try await expectFailure(previous, containing: "new request")
        let replacementResult = try await replacement.await()
        _ = try await inspect(replacementResult, height: 216, audio: false)
        print("PASS: overlapping requests settle and a reused filename remains intact")
        let remaining = try FileManager.default.contentsOfDirectory(atPath: cache.path)
        try check(!remaining.contains(where: { $0.hasPrefix(".") }), "Temporary exports leaked: \(remaining)")
        print("PASS: no partial export or thumbnail files remain")
    }
}
