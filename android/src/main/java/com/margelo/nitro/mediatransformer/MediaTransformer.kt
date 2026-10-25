package com.margelo.nitro.mediatransformer

import android.graphics.Bitmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import android.system.ErrnoException
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SonicAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.InAppMp4Muxer
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.floor
import kotlin.math.min

@UnstableApi
@DoNotStrip
class MediaTransformer : HybridMediaTransformerSpec() {
  private val mainHandler = Handler(Looper.getMainLooper())
  // All job state is confined to the main looper; blocking reads run on workers.
  private var currentJob: Job? = null

  private class Job(val promise: Promise<String>, val progress: ((Double) -> Unit)?) {
    var transformer: Transformer? = null
    var poller: Runnable? = null
    var temporary: File? = null
    var destination: File? = null
    var lastProgress = 0.0
  }

  override fun compress(inputUri: String, options: NativeCompressOptions, onProgress: ((Double) -> Unit)?): Promise<String> {
    val promise = Promise<String>()
    mainHandler.post {
      currentJob?.let { fail(it, IllegalStateException("Compression was cancelled by a new request")) }
      val job = Job(promise, onProgress)
      currentJob = job
      try {
        validate(options)
        val uri = inputUri(inputUri)
        job.destination = outputFile(options.outputFileName, "mp4", uri, options.overwrite == true)
        workers.execute {
          try {
            val metadata = readMetadata(uri)
            mainHandler.post {
              if (currentJob === job) {
                try { start(job, uri, metadata, options) } catch (error: Exception) { fail(job, error) }
              }
            }
          } catch (error: Exception) { mainHandler.post { fail(job, error) } }
        }
      } catch (error: Exception) { fail(job, error) }
    }
    return promise
  }

  private fun start(job: Job, uri: Uri, metadata: VideoMetadata, options: NativeCompressOptions) {
    val context = requireNotNull(NitroModules.applicationContext) { "Application context not available" }
    val start = options.startTime ?: 0.0
    val end = min(options.endTime ?: metadata.duration, metadata.duration)
    require(start < end) { "startTime must be before the end of the input video" }
    val clipping = MediaItem.ClippingConfiguration.Builder().setStartPositionMs((start * 1000).toLong())
      .setEndPositionMs((end * 1000).toLong()).build()
    val scale = min(1.0, min((options.maxWidth ?: metadata.width) / metadata.width,
      (options.maxHeight ?: metadata.height) / metadata.height))
    val width = (floor(metadata.width * scale / 2).toInt() * 2).coerceAtLeast(2)
    val height = (floor(metadata.height * scale / 2).toInt() * 2).coerceAtLeast(2)
    val effects = mutableListOf<Effect>(Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT))
    options.maxFrameRate?.let { effects.add(FrameDropEffect.createDefaultFrameDropEffect(it.toFloat())) }
    val audio = mutableListOf<AudioProcessor>()
    options.audioSampleRate?.let { rate -> audio.add(SonicAudioProcessor().apply { setOutputSampleRateHz(rate.toInt()) }) }
    options.audioChannels?.let { channels ->
      // Constant-power downmixes work for mono, stereo, and surround input.
      audio.add(ChannelMixingAudioProcessor().apply {
        for (inputChannels in 1..6) {
          putChannelMixingMatrix(ChannelMixingMatrix.createForConstantPower(inputChannels, channels.toInt()))
        }
      })
    }
    val edited = EditedMediaItem.Builder(MediaItem.Builder().setUri(uri).setClippingConfiguration(clipping).build())
      .setRemoveAudio(options.mute == true).setEffects(Effects(audio, effects)).build()
    val bitrate = options.bitrate ?: min(if (metadata.bitrate > 0) metadata.bitrate else 2_000_000.0,
      (width.toDouble() * height * 4).coerceAtLeast(250_000.0))
    val encoder = DefaultEncoderFactory.Builder(context)
      .setEnableFallback(false)
      .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate.toInt().coerceAtLeast(1)).build())
      .setRequestedAudioEncoderSettings(AudioEncoderSettings.Builder().setBitrate((options.audioBitrate ?: 128_000.0).toInt()).build())
      .build()
    val destination = requireNotNull(job.destination)
    val temporary = File(destination.parentFile, ".${UUID.randomUUID()}.mp4")
    job.temporary = temporary
    val transformer = Transformer.Builder(context)
      .setVideoMimeType(if (options.codec == VideoCodec.HEVC) MimeTypes.VIDEO_H265 else MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .setEncoderFactory(encoder)
      .setMuxerFactory(InAppMp4Muxer.Factory().setAttemptStreamableOutputEnabled(options.optimizeForNetworkUse != false))
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          if (currentJob !== job) return
          try {
            publish(temporary, destination, options.overwrite == true)
            stopPoller(job)
            currentJob = null
            job.progress?.invoke(1.0)
            job.promise.resolve(destination.absolutePath)
          } catch (error: Exception) { fail(job, error) }
        }
        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
          fail(job, exportException)
        }
      }).build()
    job.transformer = transformer
    job.progress?.invoke(0.0)
    transformer.start(edited, temporary.absolutePath)
    if (job.progress != null) {
      val holder = ProgressHolder()
      val poller = object : Runnable {
        override fun run() {
          if (currentJob !== job) return
          if (transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) {
            job.lastProgress = (holder.progress / 100.0).coerceIn(job.lastProgress, 0.99)
            job.progress.invoke(job.lastProgress)
          }
          mainHandler.postDelayed(this, (options.progressInterval ?: 300.0).toLong())
        }
      }
      job.poller = poller
      mainHandler.post(poller)
    }
  }

  override fun cancelCompress(): Promise<Unit> {
    val promise = Promise<Unit>()
    mainHandler.post {
      currentJob?.let { fail(it, IllegalStateException("Compression was cancelled by user")) }
      promise.resolve(Unit)
    }
    return promise
  }

  private fun stopPoller(job: Job) { job.poller?.let { mainHandler.removeCallbacks(it) }; job.poller = null }

  private fun fail(job: Job, error: Exception) {
    if (currentJob !== job) return
    currentJob = null
    stopPoller(job)
    try { job.transformer?.cancel() } catch (_: Exception) { }
    job.temporary?.delete()
    job.promise.reject(error)
  }

  override fun getVideoMetadata(inputUri: String): Promise<VideoMetadata> = background { readMetadata(inputUri(inputUri)) }

  override fun createThumbnail(inputUri: String, options: ThumbnailOptions): Promise<ThumbnailResult> = background {
    range("time", options.time, 0.0, 2147483.0)
    range("quality", options.quality, 0.0, 1.0)
    range("maxWidth", options.maxWidth, 2.0, 16384.0, true)
    range("maxHeight", options.maxHeight, 2.0, 16384.0, true)
    val uri = inputUri(inputUri)
    val metadata = readMetadata(uri)
    val time = options.time ?: 0.0
    require(time < metadata.duration) { "Thumbnail time must be before the end of the video" }
    val destination = outputFile(options.outputFileName, "jpg", uri, options.overwrite == true)
    val scale = min(1.0, min((options.maxWidth ?: metadata.width) / metadata.width, (options.maxHeight ?: metadata.height) / metadata.height))
    val width = (metadata.width * scale).toInt().coerceAtLeast(1)
    val height = (metadata.height * scale).toInt().coerceAtLeast(1)
    val retriever = retriever(uri)
    var bitmap: Bitmap? = null
    val temporary = File(destination.parentFile, ".${UUID.randomUUID()}.jpg")
    try {
      bitmap = if (Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime((time * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST, width, height)
        else retriever.getFrameAtTime((time * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST)
      val original = requireNotNull(bitmap) { "Could not decode a thumbnail frame" }
      val scaled = Bitmap.createScaledBitmap(original, width, height, true)
      if (scaled !== original) { original.recycle(); bitmap = scaled }
      temporary.outputStream().use { require(scaled.compress(Bitmap.CompressFormat.JPEG, ((options.quality ?: 0.8) * 100).toInt(), it)) { "Could not write thumbnail" } }
      publish(temporary, destination, options.overwrite == true)
      ThumbnailResult(destination.absolutePath, scaled.width.toDouble(), scaled.height.toDouble())
    } finally { bitmap?.recycle(); retriever.release(); temporary.delete() }
  }

  private fun retriever(uri: Uri): MediaMetadataRetriever {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(requireNotNull(NitroModules.applicationContext), uri)
      return retriever
    } catch (error: Exception) { retriever.release(); throw error }
  }

  private fun readMetadata(uri: Uri): VideoMetadata {
    val retriever = retriever(uri)
    try {
      fun value(key: Int) = retriever.extractMetadata(key)?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: 0.0
      val rawWidth = value(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
      val rawHeight = value(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
      val rotation = value(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
      val duration = value(MediaMetadataRetriever.METADATA_KEY_DURATION) / 1000
      require(rawWidth >= 2 && rawHeight >= 2 && duration > 0) { "Input does not contain a valid video track" }
      var fps = value(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)
      val extractor = MediaExtractor()
      try {
        extractor.setDataSource(requireNotNull(NitroModules.applicationContext), uri, null)
        for (index in 0 until extractor.trackCount) {
          val format = extractor.getTrackFormat(index)
          if (format.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true && format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
            fps = format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble()
            break
          }
        }
      } finally { extractor.release() }
      val size = if (uri.scheme == "file") File(requireNotNull(uri.path)).length().toDouble() else {
        requireNotNull(NitroModules.applicationContext).contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length.coerceAtLeast(0).toDouble() } ?: 0.0
      }
      val rotated = rotation.toInt() % 180 != 0
      return VideoMetadata(if (rotated) rawHeight else rawWidth, if (rotated) rawWidth else rawHeight,
        duration, size, value(MediaMetadataRetriever.METADATA_KEY_BITRATE), fps,
        retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes", rotation)
    } finally { retriever.release() }
  }

  private fun inputUri(value: String): Uri {
    val uri = if (value.startsWith("/")) Uri.fromFile(File(value)) else Uri.parse(value)
    require(uri.scheme == "file" || uri.scheme == "content") { "Input must be an absolute file path, file:// URL or content:// URI" }
    if (uri.scheme == "file") require(File(requireNotNull(uri.path)).let { it.isFile && it.canRead() }) { "Input video does not exist or is not readable" }
    return uri
  }

  private fun outputFile(name: String?, extension: String, input: Uri, overwrite: Boolean): File {
    val filename = name ?: "media_${UUID.randomUUID()}.$extension"
    require(filename.isNotBlank() && filename.none { it == '/' || it == '\\' || it.code < 32 } && filename.endsWith(".$extension", true)) {
      "outputFileName must be a filename ending in .$extension without directory components"
    }
    val directory = File(requireNotNull(NitroModules.applicationContext).cacheDir, "media-transformer").apply { mkdirs() }
    val output = File(directory, filename)
    if (input.scheme == "file") require(output.canonicalFile != File(requireNotNull(input.path)).canonicalFile) { "Output file must be different from the input video" }
    // A content URI can also refer to a file in our cache (for example a FileProvider URI).
    if (input.scheme == "content" && output.exists()) {
      requireNotNull(NitroModules.applicationContext).contentResolver.openFileDescriptor(input, "r")?.use {
        val source = Os.fstat(it.fileDescriptor)
        val destination = Os.stat(output.absolutePath)
        require(source.st_dev != destination.st_dev || source.st_ino != destination.st_ino) { "Output file must be different from the input video" }
      }
    }
    checkDestination(output, overwrite)
    return output
  }

  private fun checkDestination(output: File, overwrite: Boolean) {
    // Inspect only the destination entry: Android's /data/user/0 parent can
    // itself be a system symlink, which is a valid app cache location.
    val attributes = try { Os.lstat(output.absolutePath) } catch (error: ErrnoException) {
      if (error.errno == OsConstants.ENOENT) null else throw error
    }
    if (attributes != null) {
      require(OsConstants.S_ISREG(attributes.st_mode)) { "Output must be a regular file, not a directory or symbolic link" }
      require(overwrite) { "Output file already exists; set overwrite to true to replace it" }
    }
  }

  private fun publish(temporary: File, destination: File, overwrite: Boolean) {
    // Android SELinux can forbid hard links even inside app-private cache.
    // Serialize the final existence check and atomic rename across all sessions.
    synchronized(outputLock) {
      checkDestination(destination, overwrite)
      Os.rename(temporary.absolutePath, destination.absolutePath)
    }
  }

  private fun range(name: String, value: Double?, min: Double, max: Double, integer: Boolean = false) {
    require(value == null || (value.isFinite() && value >= min && value <= max && (!integer || floor(value) == value))) {
      "$name must be ${if (integer) "an integer" else "a finite number"} between $min and $max"
    }
  }

  private fun validate(options: NativeCompressOptions) {
    range("maxWidth", options.maxWidth, 2.0, 16384.0, true)
    range("maxHeight", options.maxHeight, 2.0, 16384.0, true)
    range("bitrate", options.bitrate, 1.0, Int.MAX_VALUE.toDouble(), true)
    range("maxFrameRate", options.maxFrameRate, 1.0, 240.0)
    range("startTime", options.startTime, 0.0, 2147483.0)
    range("endTime", options.endTime, 0.0, 2147483.0)
    require(options.endTime == null || options.endTime > (options.startTime ?: 0.0)) { "endTime must be greater than startTime" }
    range("audioBitrate", options.audioBitrate, 8000.0, 320000.0, true)
    range("audioChannels", options.audioChannels, 1.0, 2.0, true)
    require(options.audioSampleRate == null || options.audioSampleRate in listOf(8000.0, 11025.0, 12000.0, 16000.0, 22050.0, 24000.0, 32000.0, 44100.0, 48000.0)) { "audioSampleRate must be a supported AAC sample rate" }
    range("progressInterval", options.progressInterval, 50.0, 10000.0, true)
  }

  private fun <T> background(block: () -> T): Promise<T> {
    val promise = Promise<T>()
    workers.execute { try { promise.resolve(block()) } catch (error: Exception) { promise.reject(error) } }
    return promise
  }

  companion object {
    private val workers = Executors.newFixedThreadPool(2)
    private val outputLock = Any()
  }
}
