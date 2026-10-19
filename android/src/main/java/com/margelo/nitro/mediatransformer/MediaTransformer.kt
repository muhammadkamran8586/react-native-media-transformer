package com.margelo.nitro.mediatransformer

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.File

@UnstableApi
@DoNotStrip
class MediaTransformer : HybridMediaTransformerSpec() {
  private var currentTransformer: Transformer? = null
  private var pollerRunnable: Runnable? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var currentPromise: Promise<String>? = null
  private var currentOutputFile: File? = null

  @OptIn(UnstableApi::class)
  override fun compress(
    inputUri: String,
    options: CompressOptions,
    onProgress: ((Double) -> Unit)?
  ): Promise<String> {
    val promise = Promise<String>()
    val context = NitroModules.applicationContext ?: run {
      promise.reject(Error("Application context not available"))
      return promise
    }

    val outputFileName = options.outputFileName ?: "compressed_${System.currentTimeMillis()}.mp4"
    val uri = if (inputUri.startsWith("/")) Uri.fromFile(File(inputUri)) else inputUri.toUri()
    val outputFile = File(context.cacheDir, outputFileName)

    mainHandler.post {
      try {
        cleanupTask()

        currentPromise = promise
        currentOutputFile = outputFile

        val videoEffects = mutableListOf<Effect>()
        options.maxHeight?.let {
          videoEffects.add(Presentation.createForHeight(it.toInt()))
        }

        val editedItem = EditedMediaItem.Builder(MediaItem.fromUri(uri))
          .setEffects(Effects(emptyList<AudioProcessor>(), videoEffects))
          .build()

        val builder = Transformer.Builder(context).setVideoMimeType(MimeTypes.VIDEO_H264)

        options.bitrate?.let {
          val encoderFactory = DefaultEncoderFactory.Builder(context)
            .setRequestedVideoEncoderSettings(
              VideoEncoderSettings.Builder().setBitrate(it.toInt()).build()
            )
            .build()
          builder.setEncoderFactory(encoderFactory)
        }

        val progressHolder = ProgressHolder()

        val poller = object : Runnable {
          override fun run() {
            val transformer = currentTransformer ?: return
            if (transformer.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
              onProgress?.invoke(progressHolder.progress / 100.0)
            }
            mainHandler.postDelayed(this, 300)
          }
        }
        pollerRunnable = poller

        val transformer = builder.addListener(object : Transformer.Listener {
          override fun onCompleted(composition: Composition, exportResult: ExportResult) {
            stopPoller()
            currentPromise = null
            currentTransformer = null
            currentOutputFile = null
            onProgress?.invoke(1.0)
            promise.resolve(outputFile.absolutePath)
          }

          override fun onError(
            composition: Composition,
            exportResult: ExportResult,
            exportException: ExportException
          ) {
            stopPoller()
            deleteOutputFile()
            currentPromise = null
            currentTransformer = null
            promise.reject(exportException)
          }
        }).build()

        currentTransformer = transformer

        if (outputFile.exists()) outputFile.delete()
        transformer.start(editedItem, outputFile.absolutePath)

        if (onProgress != null) {
          mainHandler.post(poller)
        }
      } catch (e: Exception) {
        cleanupTask()
        promise.reject(e)
      }
    }

    return promise
  }

  @OptIn(UnstableApi::class)
  override fun cancelCompress(): Promise<Unit> {
    val promise = Promise<Unit>()

    mainHandler.post {
      try {
        stopPoller()

        currentTransformer?.cancel()
        currentTransformer = null

        deleteOutputFile()

        currentPromise?.reject(Error("Compression was cancelled by user"))
        currentPromise = null

        promise.resolve(Unit)
      } catch (e: Exception) {
        promise.reject(e)
      }
    }

    return promise
  }

  private fun stopPoller() {
    pollerRunnable?.let { mainHandler.removeCallbacks(it) }
    pollerRunnable = null
  }

  private fun deleteOutputFile() {
    try {
      currentOutputFile?.let {
        if (it.exists()) it.delete()
      }
    } catch (_: Exception) {
    }
    currentOutputFile = null
  }

  private fun cleanupTask() {
    stopPoller()
    currentTransformer?.cancel()
    currentTransformer = null
    deleteOutputFile()
    currentPromise = null
  }
}
