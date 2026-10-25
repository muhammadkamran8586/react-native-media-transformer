import NitroModules

enum VideoCodec { case h264, hevc }

struct NativeCompressOptions {
    var maxWidth: Double? = nil
    var maxHeight: Double? = nil
    var bitrate: Double? = nil
    var codec: VideoCodec? = nil
    var maxFrameRate: Double? = nil
    var startTime: Double? = nil
    var endTime: Double? = nil
    var mute: Bool? = nil
    var audioBitrate: Double? = nil
    var audioSampleRate: Double? = nil
    var audioChannels: Double? = nil
    var outputFileName: String? = nil
    var overwrite: Bool? = nil
    var progressInterval: Double? = nil
    var optimizeForNetworkUse: Bool? = nil
}

struct VideoMetadata {
    var width: Double
    var height: Double
    var duration: Double
    var size: Double
    var bitrate: Double
    var frameRate: Double
    var hasAudio: Bool
    var rotation: Double
}

struct ThumbnailOptions {
    var time: Double? = nil
    var maxWidth: Double? = nil
    var maxHeight: Double? = nil
    var quality: Double? = nil
    var outputFileName: String? = nil
    var overwrite: Bool? = nil
}

struct ThumbnailResult {
    var path: String
    var width: Double
    var height: Double
}

protocol HybridMediaTransformerSpec {
    func compress(inputUri: String, options: NativeCompressOptions, onProgress: ((Double) -> Void)?) throws -> Promise<String>
    func cancelCompress() throws -> Promise<Void>
    func getVideoMetadata(inputUri: String) throws -> Promise<VideoMetadata>
    func createThumbnail(inputUri: String, options: ThumbnailOptions) throws -> Promise<ThumbnailResult>
}
