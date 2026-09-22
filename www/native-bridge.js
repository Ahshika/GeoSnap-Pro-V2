// GeoSnap Pro - Bridge to the native "GeoCamNative" Capacitor plugin.
// Falls back gracefully to browser-only behavior when not running inside the Android app shell
// (e.g. previewing index.html directly in a desktop browser during development).

const NativeBridge = {
  isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  },

  plugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GeoCamNative;
  },

  async requestPermissions() {
    if (this.isNative() && this.plugin()) {
      try {
        return await this.plugin().requestAllPermissions();
      } catch (e) {
        console.warn('requestPermissions failed', e);
        return { camera: 'denied', location: 'denied' };
      }
    }
    // Browser fallback: rely on getUserMedia/geolocation prompts directly.
    return { camera: 'granted', location: 'granted' };
  },

  async checkPermissions() {
    if (this.isNative() && this.plugin()) {
      try {
        return await this.plugin().checkAllPermissions();
      } catch (e) {
        return { camera: 'unknown', location: 'unknown' };
      }
    }
    return { camera: 'granted', location: 'granted' };
  },

  // base64Jpeg: raw base64 (no data: prefix). Returns { uri }
  async saveImage(base64Jpeg, fileName, album) {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().saveImage({ base64: base64Jpeg, fileName, album });
    }
    // Browser fallback: trigger a normal download.
    const link = document.createElement('a');
    link.href = 'data:image/jpeg;base64,' + base64Jpeg;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { uri: link.href };
  },

  // base64Pdf: raw base64 (no data: prefix). Returns { uri }
  async saveDocument(base64Pdf, fileName) {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().saveDocument({ base64: base64Pdf, fileName });
    }
    const link = document.createElement('a');
    link.href = 'data:application/pdf;base64,' + base64Pdf;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { uri: link.href };
  },

  // Returns { items: [{ id, uri, dateAdded, thumbnailBase64 }] }
  async listImages(album, limit) {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().listImages({ album, limit: limit || 60 });
    }
    return { items: [] };
  },

  async deleteImage(uri) {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().deleteImage({ uri });
    }
    return { success: true };
  },

  async hasNativeFlash() {
    if (this.isNative() && this.plugin()) {
      try {
        const r = await this.plugin().hasFlash();
        return !!r.available;
      } catch (e) { return false; }
    }
    return false;
  },

  // Resolves/rejects like the underlying plugin call; callers should race this
  // against their own timeout since a stuck OEM camera stack can otherwise hang forever.
  async setNativeTorch(on) {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().setTorch({ on });
    }
    throw new Error('NOT_NATIVE');
  },

  // Full-resolution image as a data URL, for the in-app photo viewer.
  async getImageDataUrl(uri) {
    if (this.isNative() && this.plugin()) {
      const r = await this.plugin().getImageBase64({ uri });
      return 'data:image/jpeg;base64,' + r.base64;
    }
    return uri;
  },

  async openAppSettings() {
    if (this.isNative() && this.plugin()) {
      return await this.plugin().openAppSettings();
    }
  },

  // Shares a photo already saved to MediaStore (uri is the content:// URI returned by
  // saveImage/listImages) via the native Android share sheet (Intent.ACTION_SEND, handled
  // in our own plugin) - content:// MediaStore URIs need this, not a file://-based plugin.
  async shareImage(uri, dataUrlFallback, title) {
    if (this.isNative() && this.plugin() && uri) {
      await this.plugin().shareImage({ uri, title: title || 'GeoSnap Pro' });
      return;
    }
    // Browser dev-preview fallback: Web Share API with a Blob, when available.
    if (navigator.share && dataUrlFallback) {
      const response = await fetch(dataUrlFallback);
      const blob = await response.blob();
      const file = new File([blob], 'GeoSnap_Photo.jpg', { type: 'image/jpeg' });
      await navigator.share({ files: [file], title: title || 'GeoSnap Pro' });
      return;
    }
    throw new Error('SHARE_UNSUPPORTED');
  }
};
