package com.margelo.nitro.mediatransformer
  
import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class MediaTransformer : HybridMediaTransformerSpec() {
  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }
}
