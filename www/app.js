// GeoSnap Pro - Main Application Logic
const ALBUM_NAME = 'GeoSnap Pro';

document.addEventListener('DOMContentLoaded', () => {
  I18nEngine.apply();

  // === STATE ===
  let currentStream = null;
  let facingMode = 'environment';
  let flashEnabled = false;
  let selectedTemplate = 'classic';
  let cameraInitToken = 0; // bumped on every initCamera() call; stale async results are dropped
  let cameraWasActiveBeforeBackground = false;
  let flashBusy = false; // guards against overlapping torch toggles hanging the button
  let galleryItemsCache = [];
  let leafletMap = null, leafletMarker = null;
  let bigMap = null, bigMapMarker = null;
  let manualLocationActive = false;
  let manualCoords = null;

  let currentCoords = { lat: 30.0444, lng: 31.2357, alt: 0, acc: 0, compass: 0 };
  let currentAddress = I18nEngine.t('locating');
  let currentWeather = '--°C';

  let projectState = { projectName: '', inspectorName: '', siteId: '', notes: '', logoUrl: '' };

  // === DOM ===
  const videoElem = document.getElementById('video-stream');
  const hiddenCanvas = document.getElementById('hidden-canvas');
  const cameraStatusOverlay = document.getElementById('camera-status-overlay');
  const cameraStatusSpinner = document.getElementById('camera-status-spinner');
  const cameraStatusError = document.getElementById('camera-status-error');
  const btnCameraRetry = document.getElementById('btn-camera-retry');
  const btnCameraOpenSettings = document.getElementById('btn-camera-open-settings');
  const cameraViewport = document.getElementById('camera-viewport');
  const zoomLevelBadge = document.getElementById('zoom-level-badge');
  const valLat = document.getElementById('val-lat');
  const valLng = document.getElementById('val-lng');
  const valAlt = document.getElementById('val-alt');
  const valAcc = document.getElementById('val-acc');
  const valAddress = document.getElementById('val-address');
  const valDatetime = document.getElementById('val-datetime');
  const valCompass = document.getElementById('val-compass');
  const valWeather = document.getElementById('val-weather');
  const manualLocBadge = document.getElementById('manual-loc-badge');
  const permissionBanner = document.getElementById('permission-banner');

  const btnFlip = document.getElementById('btn-flip');
  const btnFlash = document.getElementById('btn-flash');
  const btnGrid = document.getElementById('btn-grid');
  const btnMore = document.getElementById('btn-more');
  const btnTemplates = document.getElementById('btn-templates');
  const btnCapture = document.getElementById('btn-capture');
  const btnGallery = document.getElementById('btn-gallery');

  const cameraGrid = document.getElementById('camera-grid');
  const modalTemplates = document.getElementById('modal-templates');
  const modalProject = document.getElementById('modal-project');
  const modalPhotoResult = document.getElementById('modal-photo-result');
  const modalGallery = document.getElementById('modal-gallery');
  const modalLocationFix = document.getElementById('modal-location-fix');
  const modalMore = document.getElementById('modal-more');

  const resultPhotoImg = document.getElementById('result-photo-img');
  const resultSavingIndicator = document.getElementById('result-saving-indicator');
  const resultSaveStatus = document.getElementById('result-save-status');
  const btnShare = document.getElementById('btn-share');
  const btnRetake = document.getElementById('btn-retake');
  const btnDone = document.getElementById('btn-done');
  const galleryGridContainer = document.getElementById('gallery-grid-container');
  const galleryEmptyHint = document.getElementById('gallery-empty-hint');
  const galleryThumbImg = document.getElementById('gallery-thumb-img');
  const galleryThumbIcon = document.getElementById('gallery-thumb-icon');
  const galleryCount = document.getElementById('gallery-count');

  const modalPhotoViewer = document.getElementById('modal-photo-viewer');
  const viewerPhotoImg = document.getElementById('viewer-photo-img');
  const viewerLoadingSpinner = document.getElementById('viewer-loading-spinner');
  const viewerDateLabel = document.getElementById('viewer-date-label');
  const btnViewerShare = document.getElementById('btn-viewer-share');
  const btnViewerDelete = document.getElementById('btn-viewer-delete');

  let lastCapturedUri = null;
  let lastCapturedDataUrl = null;

  // === HELPERS ===
  // Races a promise against a hard timeout so a stuck native/WebView call (flaky OEM
  // camera stacks, WebView torch, etc.) can never freeze the UI - it just fails fast instead.
  function withTimeout(promise, ms, timeoutError) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutError || 'TIMEOUT')), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  // === TOAST ===
  function toast(msg) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = 'toast-item pointer-events-auto';
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
  }

  function openModal(el) { el.classList.remove('hidden'); }
  function closeModal(el) { el.classList.add('hidden'); }
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => closeModal(document.getElementById(btn.dataset.target)));
  });

  // === 0. PERMISSIONS ===
  async function ensurePermissions() {
    const status = await NativeBridge.checkPermissions();
    if (status.camera !== 'granted' || status.location !== 'granted') {
      permissionBanner.classList.remove('hidden');
    } else {
      permissionBanner.classList.add('hidden');
    }
    return status;
  }

  async function requestPermissionsFlow() {
    const result = await NativeBridge.requestPermissions();
    if (result.camera === 'granted' && result.location === 'granted') {
      toast(I18nEngine.t('toast_permissions_ok'));
      permissionBanner.classList.add('hidden');
    } else {
      if (result.camera !== 'granted') toast(I18nEngine.t('toast_camera_denied'));
      if (result.location !== 'granted') toast(I18nEngine.t('toast_location_denied'));
    }
    await initCamera();
    startLocationTracking();
  }
  document.getElementById('btn-grant-permissions').addEventListener('click', requestPermissionsFlow);

  // === 1. CAMERA ===
  // Three visible states so a stuck/failed camera is never a silent black screen:
  // loading (spinner) -> ready (video visible) -> error (tap-to-retry).
  function showCameraLoading() {
    cameraStatusOverlay.classList.remove('hidden');
    cameraStatusSpinner.classList.remove('hidden');
    cameraStatusError.classList.add('hidden');
    videoElem.classList.add('hidden');
  }
  function showCameraError() {
    cameraStatusOverlay.classList.remove('hidden');
    cameraStatusSpinner.classList.add('hidden');
    cameraStatusError.classList.remove('hidden');
    videoElem.classList.add('hidden');
  }
  function showCameraReady() {
    cameraStatusOverlay.classList.add('hidden');
    videoElem.classList.remove('hidden');
  }

  let autoRetryCount = 0;
  let autoRetryTimer = null;

  function stopCamera() {
    if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
    if (currentStream) {
      currentStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    }
    currentStream = null;
    videoElem.srcObject = null;
  }

  // Guarded against: (a) overlapping calls (flip/resume firing while a previous init is
  // still pending - a common cause of the camera "hanging" on many OEM WebViews), and
  // (b) a getUserMedia() promise that never resolves - it's raced against a hard timeout
  // instead of leaving the preview stuck forever.
  async function initCamera() {
    const myToken = ++cameraInitToken;
    stopCamera();
    showCameraLoading();

    const constraints = { video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };
    let stream;
    try {
      stream = await withTimeout(navigator.mediaDevices.getUserMedia(constraints), 8000, 'CAMERA_TIMEOUT');
    } catch (err) {
      console.warn('Camera error, trying fallback', err);
      try {
        stream = await withTimeout(navigator.mediaDevices.getUserMedia({ video: true, audio: false }), 8000, 'CAMERA_TIMEOUT');
      } catch (e2) {
        if (myToken === cameraInitToken) showCameraError();
        return;
      }
    }

    // Another initCamera() call superseded this one (e.g. rapid flip, or backgrounded
    // again before this resolved) - drop this stream instead of racing it onto the video.
    if (myToken !== cameraInitToken) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      return;
    }
    currentStream = stream;
    videoElem.srcObject = currentStream;
    flashEnabled = false;
    btnFlash.classList.remove('text-amber-400');
    autoRetryCount = 0;

    // Some OEM WebViews silently kill the camera track mid-session (thermal throttling,
    // another app stealing the camera, etc.) leaving a frozen last frame with no error.
    // Auto-recover a few times with backoff before giving up and showing tap-to-retry.
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (myToken !== cameraInitToken) return;
        if (autoRetryCount < 3) {
          autoRetryCount++;
          autoRetryTimer = setTimeout(() => initCamera(), 600 * autoRetryCount);
        } else {
          showCameraError();
        }
      });
    }

    // On some OEM WebViews (seen on certain MediaTek/Unisoc-based phones) the stream attaches
    // and 'loadedmetadata' fires normally, but no actual frame ever decodes - the video element
    // is left showing the WebView's own "broken media" glyph forever, with our UI none the wiser.
    // So "ready" is defined by an actual decoded frame (requestVideoFrameCallback), not metadata;
    // if no frame arrives within a few seconds of metadata loading, treat it as a failed camera.
    let frameWatchdog = null;
    function armFrameWatchdog() {
      frameWatchdog = setTimeout(() => {
        if (myToken !== cameraInitToken) return;
        console.warn('Camera stream attached but never produced a frame - treating as failed');
        stopCamera();
        showCameraError();
      }, 5000);
    }
    function onFirstFrame() {
      if (frameWatchdog) { clearTimeout(frameWatchdog); frameWatchdog = null; }
      if (myToken === cameraInitToken) showCameraReady();
    }

    videoElem.addEventListener('loadedmetadata', function onMeta() {
      videoElem.removeEventListener('loadedmetadata', onMeta);
      if (myToken !== cameraInitToken) return;
      if (typeof videoElem.requestVideoFrameCallback === 'function') {
        armFrameWatchdog();
        videoElem.requestVideoFrameCallback(onFirstFrame);
      } else {
        // Older WebView without frame callbacks - fall back to metadata readiness.
        showCameraReady();
      }
    }, { once: true });
  }

  btnCameraRetry.addEventListener('click', (e) => { e.stopPropagation(); initCamera(); });
  btnCameraOpenSettings.addEventListener('click', (e) => { e.stopPropagation(); NativeBridge.openAppSettings(); });
  cameraStatusOverlay.addEventListener('click', () => {
    if (!cameraStatusError.classList.contains('hidden')) initCamera();
  });

  // === LIFECYCLE: stop the camera in the background, cleanly reopen it in the foreground.
  // Simply re-calling getUserMedia() after backgrounding is NOT enough on many Android
  // WebViews: Chromium's video capture service can be left in a broken state by the
  // Activity pause/resume cycle and never recovers within the same WebView instance, even
  // though a fresh page load works fine (this is a known WebView-vs-full-Chrome gap, not a
  // hardware issue - the phone's own native Camera app is unaffected by backgrounding).
  // The reliable fix is a full page reload on resume, which forces Chromium to reinitialize
  // capture from scratch. UI-only state (project info, selected template) is persisted
  // first so the reload is invisible to the user.
  function handleAppBackground() {
    cameraWasActiveBeforeBackground = !!currentStream;
    if (cameraWasActiveBeforeBackground) persistUiState();
    stopCamera();
  }
  function handleAppForeground() {
    if (cameraWasActiveBeforeBackground) {
      cameraWasActiveBeforeBackground = false;
      window.location.reload();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) handleAppBackground(); else handleAppForeground();
  });
  // Capacitor's native bridge also dispatches these Cordova-compat events on pause/resume.
  document.addEventListener('pause', handleAppBackground);
  document.addEventListener('resume', handleAppForeground);

  // Square grid overlay, matching a phone camera's grid tiling (not stretched to the preview's aspect ratio).
  function updateGridOverlay() {
    const rect = videoElem.getBoundingClientRect();
    const size = Math.round(Math.min(rect.width, rect.height) / 3);
    if (!size) return;
    const lineColor = 'rgba(255,255,255,0.55)';
    cameraGrid.style.backgroundImage = `
      repeating-linear-gradient(to right, transparent 0, transparent ${size - 1}px, ${lineColor} ${size - 1}px, ${lineColor} ${size}px),
      repeating-linear-gradient(to bottom, transparent 0, transparent ${size - 1}px, ${lineColor} ${size - 1}px, ${lineColor} ${size}px)
    `;
    cameraGrid.style.backgroundSize = `${size}px ${size}px`;
  }
  videoElem.addEventListener('loadedmetadata', updateGridOverlay);
  window.addEventListener('resize', updateGridOverlay);
  window.addEventListener('orientationchange', () => setTimeout(updateGridOverlay, 300));

  btnFlip.addEventListener('click', () => {
    facingMode = facingMode === 'environment' ? 'user' : 'environment';
    setZoomLevel(1);
    initCamera();
  });

  // === PINCH-TO-ZOOM (live preview) ===
  // Deliberately a software crop-zoom applied identically to preview and capture, rather
  // than the MediaStream "zoom" constraint: hardware zoom support via getUserMedia is
  // inconsistent across phones/lenses, while a canvas crop works the same on every device.
  const MIN_ZOOM = 1, MAX_ZOOM = 4;
  let zoomLevel = 1;
  let zoomBadgeHideTimer = null;

  function setZoomLevel(level) {
    zoomLevel = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level));
    videoElem.style.transform = `scale(${zoomLevel})`;
    zoomLevelBadge.textContent = zoomLevel.toFixed(1) + 'x';
    zoomLevelBadge.classList.remove('hidden');
    if (zoomBadgeHideTimer) clearTimeout(zoomBadgeHideTimer);
    zoomBadgeHideTimer = setTimeout(() => zoomLevelBadge.classList.add('hidden'), 1200);
  }

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  let pinchStartDistance = 0;
  let pinchStartZoom = 1;
  cameraViewport.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDistance = touchDistance(e.touches);
      pinchStartZoom = zoomLevel;
    }
  }, { passive: true });
  cameraViewport.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDistance > 0) {
      e.preventDefault();
      const ratio = touchDistance(e.touches) / pinchStartDistance;
      setZoomLevel(pinchStartZoom * ratio);
    }
  }, { passive: false });
  cameraViewport.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDistance = 0;
  });

  // Native Camera2 torch is tried first (fast, reliable, independent of the WebView's own
  // camera session); the WebView getUserMedia torch constraint is the fallback. Both paths
  // are raced against a timeout so a stuck OEM camera stack can never hang this button -
  // it always resolves to either "on/off" or "unsupported" within ~1.5s.
  btnFlash.addEventListener('click', async () => {
    if (flashBusy) return;
    flashBusy = true;
    const nextState = !flashEnabled;
    try {
      let applied = false;

      if (NativeBridge.isNative()) {
        try {
          await withTimeout(NativeBridge.setNativeTorch(nextState), 1500, 'TORCH_TIMEOUT');
          applied = true;
        } catch (e) {
          console.warn('Native torch unavailable, falling back to WebView torch:', e);
        }
      }

      if (!applied && currentStream) {
        const track = currentStream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) {
          try {
            await withTimeout(track.applyConstraints({ advanced: [{ torch: nextState }] }), 1500, 'TORCH_TIMEOUT');
            applied = true;
          } catch (e) {
            console.warn('WebView torch failed:', e);
          }
        }
      }

      if (applied) {
        flashEnabled = nextState;
        btnFlash.classList.toggle('text-amber-400', flashEnabled);
      } else {
        toast(I18nEngine.t('torch_unsupported'));
      }
    } finally {
      flashBusy = false;
    }
  });

  btnGrid.addEventListener('click', () => {
    cameraGrid.classList.toggle('hidden');
    btnGrid.classList.toggle('text-emerald-400');
    if (!cameraGrid.classList.contains('hidden')) updateGridOverlay();
  });

  // === 2. MAPS ===
  function initMiniMap() {
    const mapContainer = document.getElementById('mini-map-classic');
    if (!mapContainer || leafletMap) return;
    leafletMap = L.map('mini-map-classic', { zoomControl: false, attributionControl: false, dragging: false, touchZoom: false, scrollWheelZoom: false })
      .setView([currentCoords.lat, currentCoords.lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(leafletMap);
    leafletMarker = L.marker([currentCoords.lat, currentCoords.lng]).addTo(leafletMap);
  }
  function updateMiniMap(lat, lng) {
    if (leafletMap && leafletMarker) {
      leafletMap.setView([lat, lng], 15);
      leafletMarker.setLatLng([lat, lng]);
      leafletMap.invalidateSize();
    }
  }

  document.getElementById('mini-map-tap-classic').addEventListener('click', openLocationFixModal);
  document.getElementById('menu-location-fix').addEventListener('click', () => { closeModal(modalMore); openLocationFixModal(); });

  function openLocationFixModal() {
    openModal(modalLocationFix);
    setTimeout(() => {
      if (!bigMap) {
        bigMap = L.map('big-map-container').setView([currentCoords.lat, currentCoords.lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(bigMap);
        bigMapMarker = L.marker([currentCoords.lat, currentCoords.lng], { draggable: true }).addTo(bigMap);
      } else {
        bigMap.invalidateSize();
        bigMap.setView([currentCoords.lat, currentCoords.lng], 16);
        bigMapMarker.setLatLng([currentCoords.lat, currentCoords.lng]);
      }
    }, 150);
  }

  document.getElementById('btn-confirm-manual-loc').addEventListener('click', () => {
    const pos = bigMapMarker.getLatLng();
    manualCoords = { lat: pos.lat, lng: pos.lng };
    manualLocationActive = true;
    manualLocBadge.classList.remove('hidden');
    currentCoords.lat = pos.lat;
    currentCoords.lng = pos.lng;
    updateLocationUI();
    updateMiniMap(pos.lat, pos.lng);
    updateQRCodes();
    fetchReverseGeocode(pos.lat, pos.lng, true);
    fetchWeather(pos.lat, pos.lng);
    closeModal(modalLocationFix);
  });

  document.getElementById('btn-use-gps').addEventListener('click', () => {
    manualLocationActive = false;
    manualCoords = null;
    manualLocBadge.classList.add('hidden');
    closeModal(modalLocationFix);
  });

  // === 3. GEOLOCATION & WEATHER ===
  function startLocationTracking() {
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.watchPosition(
      (pos) => {
        if (manualLocationActive) return; // manual override takes precedence
        currentCoords.lat = pos.coords.latitude;
        currentCoords.lng = pos.coords.longitude;
        currentCoords.alt = pos.coords.altitude ? Math.round(pos.coords.altitude) : 0;
        currentCoords.acc = Math.round(pos.coords.accuracy || 5);
        updateLocationUI();
        updateMiniMap(currentCoords.lat, currentCoords.lng);
        updateQRCodes();
        fetchReverseGeocode(currentCoords.lat, currentCoords.lng);
        fetchWeather(currentCoords.lat, currentCoords.lng);
      },
      (err) => {
        console.warn('Geolocation warning:', err);
        currentAddress = I18nEngine.t('default_address_fallback');
        updateLocationUI();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  function updateLocationUI() {
    const latStr = currentCoords.lat.toFixed(6) + '°';
    const lngStr = currentCoords.lng.toFixed(6) + '°';
    valLat.textContent = latStr;
    valLng.textContent = lngStr;
    valAlt.textContent = currentCoords.alt + ' م';
    valAcc.textContent = '±' + currentCoords.acc + ' م';
    document.getElementById('val-coords-eng').textContent = `${latStr}, ${lngStr}`;
    document.getElementById('val-coords-minimal').textContent = `${latStr}, ${lngStr}`;
    document.getElementById('val-coords-badge').textContent = `${latStr}, ${lngStr}`;
  }

  if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientation', (e) => {
      if (e.alpha !== null) {
        currentCoords.compass = Math.round(360 - e.alpha);
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const dir = dirs[Math.round(currentCoords.compass / 45) % 8];
        valCompass.textContent = `${dir} ${currentCoords.compass}°`;
      }
    });
  }

  let lastGeocodeTime = 0;
  async function fetchReverseGeocode(lat, lng, force) {
    if (!force && Date.now() - lastGeocodeTime < 10000) return;
    lastGeocodeTime = Date.now();
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=${I18nEngine.current}`);
      const data = await res.json();
      if (data && data.display_name) {
        currentAddress = data.display_name;
        valAddress.textContent = currentAddress;
        document.getElementById('val-address-eng').textContent = currentAddress;
        document.getElementById('val-address-minimal').textContent = currentAddress;
        document.getElementById('val-address-badge').textContent = currentAddress;
      }
    } catch (e) { console.warn('Geocode API error:', e); }
  }

  async function fetchWeather(lat, lng) {
    try {
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`);
      const data = await res.json();
      if (data && data.current_weather) {
        currentWeather = `${Math.round(data.current_weather.temperature)}°C`;
        valWeather.textContent = currentWeather;
      }
    } catch (e) { console.warn('Weather API error:', e); }
  }

  function updateDateTimeTicker() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];
    valDatetime.textContent = `${dateStr} ${timeStr}`;
    document.getElementById('val-datetime-eng').textContent = timeStr;
    document.getElementById('val-date-minimal').textContent = dateStr;
    document.getElementById('val-time-minimal').textContent = timeStr;
    document.getElementById('val-date-badge').textContent = `${dateStr} ${timeStr}`;
  }
  setInterval(updateDateTimeTicker, 1000);
  updateDateTimeTicker();

  // === 4. QR CODES ===
  function updateQRCodes() {
    const mapUrl = `https://maps.google.com/?q=${currentCoords.lat},${currentCoords.lng}`;
    const qrClassicBox = document.getElementById('qrcode-classic');
    const qrEngBox = document.getElementById('qrcode-eng');
    if (qrClassicBox) { qrClassicBox.innerHTML = ''; new QRCode(qrClassicBox, { text: mapUrl, width: 48, height: 48 }); }
    if (qrEngBox) { qrEngBox.innerHTML = ''; new QRCode(qrEngBox, { text: mapUrl, width: 44, height: 44 }); }
  }

  // === STATE PERSISTENCE (small text fields only - never photos) ===
  // Backgrounding this app can force a full page reload to recover the camera (see the
  // LIFECYCLE section below), which would otherwise silently wipe whatever the user typed
  // into the project/template panels. Persisted here so a reload is invisible to the user.
  const STATE_STORAGE_KEY = 'geosnap_ui_state_v1';
  function persistUiState() {
    try {
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify({
        selectedTemplate,
        projectName: projectState.projectName,
        inspectorName: projectState.inspectorName,
        siteId: projectState.siteId,
        notes: projectState.notes
        // logoUrl deliberately excluded: a data URL image is exactly the kind of large
        // blob that made localStorage unreliable in V1 - not worth risking for a reload.
      }));
    } catch (e) { console.warn('Could not persist UI state', e); }
  }
  function restoreUiState() {
    try {
      const raw = localStorage.getItem(STATE_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.selectedTemplate) selectedTemplate = saved.selectedTemplate;
      projectState.projectName = saved.projectName || '';
      projectState.inspectorName = saved.inspectorName || '';
      projectState.siteId = saved.siteId || '';
      projectState.notes = saved.notes || '';
      document.getElementById('input-project-name').value = projectState.projectName;
      document.getElementById('input-inspector-name').value = projectState.inspectorName;
      document.getElementById('input-site-id').value = projectState.siteId;
      document.getElementById('input-notes').value = projectState.notes;
    } catch (e) { console.warn('Could not restore UI state', e); }
  }

  // === 5. TEMPLATES ===
  btnTemplates.addEventListener('click', () => openModal(modalTemplates));
  document.querySelectorAll('.template-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.template-select-btn').forEach(b => {
        b.classList.remove('border-sky-500', 'bg-sky-500/10');
        b.classList.add('border-slate-700', 'bg-slate-800/40');
      });
      btn.classList.remove('border-slate-700', 'bg-slate-800/40');
      btn.classList.add('border-sky-500', 'bg-sky-500/10');
      selectedTemplate = btn.dataset.template;
      applySelectedTemplateUI();
      persistUiState();
      closeModal(modalTemplates);
    });
  });
  function applySelectedTemplateUI() {
    document.querySelectorAll('.watermark-card').forEach(card => card.classList.add('hidden'));
    const el = document.getElementById('template-' + selectedTemplate);
    if (el) el.classList.remove('hidden');
    document.querySelectorAll('.template-select-btn').forEach(b => {
      const isActive = b.dataset.template === selectedTemplate;
      b.classList.toggle('border-sky-500', isActive);
      b.classList.toggle('bg-sky-500/10', isActive);
      b.classList.toggle('border-slate-700', !isActive);
      b.classList.toggle('bg-slate-800/40', !isActive);
    });
  }

  // === 6. PROJECT & NOTES ===
  document.getElementById('menu-project').addEventListener('click', () => { closeModal(modalMore); openModal(modalProject); });
  document.getElementById('input-logo-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        projectState.logoUrl = evt.target.result;
        const logoImg = document.getElementById('val-logo-img');
        logoImg.src = projectState.logoUrl;
        logoImg.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
    }
  });
  function applyProjectStateUI() {
    if (projectState.projectName) {
      document.getElementById('classic-custom-row').classList.remove('hidden');
      document.getElementById('val-project-name').textContent = projectState.projectName;
      document.getElementById('eng-project-title').textContent = projectState.projectName;
    }
    if (projectState.inspectorName) {
      document.getElementById('val-inspector').textContent = projectState.inspectorName;
      document.getElementById('eng-inspector-name').textContent = projectState.inspectorName;
    }
    if (projectState.siteId) document.getElementById('eng-site-id').textContent = 'SITE-ID: ' + projectState.siteId;
    if (projectState.notes) document.getElementById('eng-notes-text').textContent = projectState.notes;
  }
  document.getElementById('save-project-notes').addEventListener('click', () => {
    projectState.projectName = document.getElementById('input-project-name').value;
    projectState.inspectorName = document.getElementById('input-inspector-name').value;
    projectState.siteId = document.getElementById('input-site-id').value;
    projectState.notes = document.getElementById('input-notes').value;
    applyProjectStateUI();
    persistUiState();
    closeModal(modalProject);
  });

  // === PINCH-TO-ZOOM & DOUBLE-TAP (photo viewers) ===
  // Reusable for both the just-captured result preview and the full-resolution gallery
  // viewer: pinch to zoom in/out, drag to pan while zoomed, double-tap to toggle 2x/1x.
  function makeZoomableImage(imgEl) {
    let scale = 1, translateX = 0, translateY = 0;
    let startDistance = 0, startScale = 1;
    let isPanning = false, panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;
    let lastTapTime = 0;

    function apply() {
      imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }
    function reset() {
      scale = 1; translateX = 0; translateY = 0;
      apply();
    }

    imgEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        startDistance = touchDistance(e.touches);
        startScale = scale;
      } else if (e.touches.length === 1) {
        if (scale > 1) {
          isPanning = true;
          panStartX = e.touches[0].clientX;
          panStartY = e.touches[0].clientY;
          panOriginX = translateX;
          panOriginY = translateY;
        }
        const now = Date.now();
        if (now - lastTapTime < 300) {
          if (scale > 1) reset(); else { scale = 2; apply(); }
        }
        lastTapTime = now;
      }
    }, { passive: true });

    imgEl.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && startDistance > 0) {
        e.preventDefault();
        const ratio = touchDistance(e.touches) / startDistance;
        scale = Math.min(4, Math.max(1, startScale * ratio));
        apply();
      } else if (e.touches.length === 1 && isPanning) {
        e.preventDefault();
        translateX = panOriginX + (e.touches[0].clientX - panStartX);
        translateY = panOriginY + (e.touches[0].clientY - panStartY);
        apply();
      }
    }, { passive: false });

    imgEl.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) startDistance = 0;
      if (e.touches.length === 0) {
        isPanning = false;
        if (scale <= 1) reset();
      }
    });

    return { reset };
  }
  const resultZoomCtl = makeZoomableImage(resultPhotoImg);
  const viewerZoomCtl = makeZoomableImage(viewerPhotoImg);

  // === 7. CAPTURE, EXIF EMBED & NATIVE SAVE ===
  btnCapture.addEventListener('click', () => {
    btnCapture.classList.add('capture-active');
    setTimeout(() => btnCapture.classList.remove('capture-active'), 200);
    capturePhotoWithWatermark();
  });

  function degToDmsRational(degFloat) {
    const deg = Math.floor(degFloat);
    const minFloat = (degFloat - deg) * 60;
    const min = Math.floor(minFloat);
    const secFloat = (minFloat - min) * 60;
    const sec = Math.round(secFloat * 100);
    return [[deg, 1], [min, 1], [sec, 100]];
  }

  function embedExifGps(dataUrl, lat, lng, alt, addressText) {
    try {
      const zeroth = {};
      const exifIfd = {};
      const gps = {};
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const exifDate = `${now.getFullYear()}:${pad(now.getMonth() + 1)}:${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

      zeroth[piexif.ImageIFD.Software] = 'GeoSnap Pro';
      if (addressText) zeroth[piexif.ImageIFD.ImageDescription] = addressText.substring(0, 250);
      exifIfd[piexif.ExifIFD.DateTimeOriginal] = exifDate;

      gps[piexif.GPSIFD.GPSLatitudeRef] = lat >= 0 ? 'N' : 'S';
      gps[piexif.GPSIFD.GPSLatitude] = degToDmsRational(Math.abs(lat));
      gps[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
      gps[piexif.GPSIFD.GPSLongitude] = degToDmsRational(Math.abs(lng));
      gps[piexif.GPSIFD.GPSAltitudeRef] = alt >= 0 ? 0 : 1;
      gps[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(alt || 0) * 100), 100];

      const exifObj = { '0th': zeroth, 'Exif': exifIfd, 'GPS': gps };
      const exifBytes = piexif.dump(exifObj);
      return piexif.insert(exifBytes, dataUrl);
    } catch (e) {
      console.warn('EXIF embed failed, saving without EXIF GPS:', e);
      return dataUrl;
    }
  }

  function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function drawRows(ctx, rows, x0, textAlign, direction, startY, maxWidth) {
    ctx.textAlign = textAlign;
    ctx.direction = direction;
    let y = startY;
    rows.forEach(r => {
      y += r.gapBefore;
      ctx.font = r.font;
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, x0, y, maxWidth);
      y += r.h;
    });
    return y;
  }

  function drawQrBox(ctx, qrSize, x, y) {
    try {
      const qrCanvas = document.querySelector('#qrcode-classic canvas') || document.querySelector('#qrcode-eng canvas');
      if (!qrCanvas) return false;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(x - 4, y - 4, qrSize + 8, qrSize + 8, 8);
      ctx.fill();
      ctx.drawImage(qrCanvas, x, y, qrSize, qrSize);
      return true;
    } catch (e) { console.warn('QR draw skipped:', e); return false; }
  }

  function drawClassicStamp(ctx, width, height, isAr) {
    const outerPadding = width * 0.03;
    const cardX = outerPadding;
    const cardWidth = width - outerPadding * 2;
    const innerPad = Math.round(width * 0.028);
    const qrSize = Math.max(56, Math.min(96, width * 0.14));
    const qrMargin = 14;
    const textMaxWidth = cardWidth - qrSize * 2 - qrMargin * 2 - innerPad * 2;

    const fontMain = Math.round(width * 0.024);
    const fontSecondary = Math.round(width * 0.02);
    const lineHeight = Math.round(fontMain * 1.35);
    const lineHeightSm = Math.round(fontSecondary * 1.4);

    ctx.font = `bold ${fontMain}px Arial, sans-serif`;
    const addressLines = wrapText(ctx, currentAddress || '', textMaxWidth).slice(0, 3);
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];
    const compassDir = getCompassDir();

    const rows = [];
    addressLines.forEach((l, i) => rows.push({ text: l, font: `bold ${fontMain}px Arial, sans-serif`, color: '#ffffff', h: lineHeight, gapBefore: i === 0 ? 0 : 4 }));
    rows.push({ text: `${I18nEngine.t('lat_label')} ${currentCoords.lat.toFixed(6)}°   ${I18nEngine.t('lng_label')} ${currentCoords.lng.toFixed(6)}°`, font: `bold ${fontSecondary}px monospace`, color: '#38bdf8', h: lineHeightSm, gapBefore: 6 });
    rows.push({ text: `${I18nEngine.t('alt_label')} ${currentCoords.alt}m   ${I18nEngine.t('acc_label')} ±${currentCoords.acc}m`, font: `${fontSecondary}px Arial, sans-serif`, color: '#cbd5e1', h: lineHeightSm, gapBefore: 2 });
    if (currentWeather && currentWeather !== '--°C') {
      rows.push({ text: `${I18nEngine.t('weather_label')} ${currentWeather}`, font: `${fontSecondary}px Arial, sans-serif`, color: '#cbd5e1', h: lineHeightSm, gapBefore: 2 });
    }
    rows.push({ text: `${I18nEngine.t('date_label')} ${dateStr}   ${I18nEngine.t('time_label')} ${timeStr}`, font: `bold ${fontSecondary}px monospace`, color: '#f59e0b', h: lineHeightSm, gapBefore: 6 });
    if (projectState.projectName) {
      rows.push({ text: `${projectState.projectName}${projectState.inspectorName ? ' — ' + projectState.inspectorName : ''}`, font: `bold ${fontSecondary}px Arial, sans-serif`, color: '#818cf8', h: lineHeightSm, gapBefore: 6 });
    }

    let contentHeight = innerPad * 2;
    rows.forEach(r => { contentHeight += r.h + r.gapBefore; });
    let cardHeight = Math.max(contentHeight, qrSize + qrMargin * 2);
    cardHeight = Math.min(cardHeight, height * 0.55);
    const cardY = height - cardHeight - outerPadding;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 18);
    ctx.fill();
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Compass badge box (safe local drawing, replaces the live mini-map thumbnail)
    const compassBoxX = isAr ? cardX + cardWidth - qrSize - innerPad : cardX + innerPad;
    const compassBoxY = cardY + (cardHeight - qrSize) / 2;
    ctx.fillStyle = 'rgba(2,132,199,0.18)';
    ctx.beginPath();
    ctx.roundRect(compassBoxX, compassBoxY, qrSize, qrSize, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56,189,248,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.direction = 'ltr';
    ctx.fillStyle = '#38bdf8';
    ctx.font = `bold ${Math.round(qrSize * 0.28)}px Arial, sans-serif`;
    ctx.fillText('🧭', compassBoxX + qrSize / 2, compassBoxY + qrSize * 0.45);
    ctx.font = `bold ${Math.round(qrSize * 0.18)}px Arial, sans-serif`;
    ctx.fillText(`${compassDir} ${currentCoords.compass}°`, compassBoxX + qrSize / 2, compassBoxY + qrSize * 0.78);

    const qrX = isAr ? cardX + innerPad : cardX + cardWidth - qrSize - innerPad;
    const qrY = cardY + (cardHeight - qrSize) / 2;
    drawQrBox(ctx, qrSize, qrX, qrY);

    const textX0 = isAr ? compassBoxX - innerPad : compassBoxX + qrSize + innerPad;
    drawRows(ctx, rows, textX0, isAr ? 'right' : 'left', isAr ? 'rtl' : 'ltr', cardY + innerPad + fontMain * 0.75, textMaxWidth + 20);
  }

  function drawEngineeringStamp(ctx, width, height, isAr) {
    const outerPadding = width * 0.03;
    const cardX = outerPadding;
    const cardWidth = width - outerPadding * 2;
    const innerPad = Math.round(width * 0.028);
    const qrSize = Math.max(64, Math.min(110, width * 0.16));
    const fontMain = Math.round(width * 0.024);
    const fontSecondary = Math.round(width * 0.02);
    const lineHeightSm = Math.round(fontSecondary * 1.45);
    const textMaxWidth = cardWidth - qrSize - innerPad * 3;

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0];

    ctx.font = `${fontSecondary}px Arial, sans-serif`;
    const addressLines = wrapText(ctx, `${I18nEngine.t('location_label')} ${currentAddress || ''}`, textMaxWidth).slice(0, 3);

    const rows = [];
    addressLines.forEach((l, i) => rows.push({ text: l, font: `${fontSecondary}px Arial, sans-serif`, color: '#e2e8f0', h: lineHeightSm, gapBefore: i === 0 ? 0 : 2 }));
    rows.push({ text: `${I18nEngine.t('coords_label')} ${currentCoords.lat.toFixed(6)}, ${currentCoords.lng.toFixed(6)}`, font: `bold ${fontSecondary}px monospace`, color: '#a5b4fc', h: lineHeightSm, gapBefore: 4 });
    rows.push({ text: `${I18nEngine.t('alt_label')} ${currentCoords.alt}m   ${I18nEngine.t('acc_label')} ±${currentCoords.acc}m   ${I18nEngine.t('compass_label')} ${getCompassDir()} ${currentCoords.compass}°`, font: `${fontSecondary}px Arial, sans-serif`, color: '#cbd5e1', h: lineHeightSm, gapBefore: 4 });
    rows.push({ text: `${I18nEngine.t('inspector_label')} ${projectState.inspectorName || '--'}`, font: `bold ${fontSecondary}px Arial, sans-serif`, color: '#f1f5f9', h: lineHeightSm, gapBefore: 6 });
    if (projectState.notes) {
      const noteLines = wrapText(ctx, `${I18nEngine.t('notes_label')} ${projectState.notes}`, textMaxWidth).slice(0, 2);
      noteLines.forEach((l, i) => rows.push({ text: l, font: `italic ${fontSecondary}px Arial, sans-serif`, color: '#fcd34d', h: lineHeightSm, gapBefore: i === 0 ? 4 : 2 }));
    }

    const headerH = Math.round(fontMain * 1.9);
    let contentHeight = headerH + innerPad * 2;
    rows.forEach(r => { contentHeight += r.h + r.gapBefore; });
    let cardHeight = Math.max(contentHeight, headerH + qrSize + innerPad * 2);
    cardHeight = Math.min(cardHeight, height * 0.6);
    const cardY = height - cardHeight - outerPadding;

    ctx.fillStyle = 'rgba(2, 6, 23, 0.92)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 18);
    ctx.fill();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(99,102,241,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + innerPad, cardY + headerH);
    ctx.lineTo(cardX + cardWidth - innerPad, cardY + headerH);
    ctx.stroke();

    ctx.textAlign = isAr ? 'right' : 'left';
    ctx.direction = isAr ? 'rtl' : 'ltr';
    const headerAnchor = isAr ? cardX + cardWidth - innerPad : cardX + innerPad;
    ctx.font = `bold ${Math.round(fontMain * 0.95)}px Arial, sans-serif`;
    ctx.fillStyle = '#a5b4fc';
    ctx.fillText(projectState.projectName || I18nEngine.t('eng_default_title'), headerAnchor, cardY + Math.round(headerH * 0.55), textMaxWidth + 20);
    ctx.font = `${Math.round(fontSecondary * 0.85)}px monospace`;
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`SITE-ID: ${projectState.siteId || '--'}`, headerAnchor, cardY + Math.round(headerH * 0.9), textMaxWidth + 20);

    ctx.textAlign = isAr ? 'left' : 'right';
    const timeAnchor = isAr ? cardX + innerPad : cardX + cardWidth - innerPad;
    ctx.font = `bold ${Math.round(fontSecondary * 0.9)}px monospace`;
    ctx.fillStyle = '#c7d2fe';
    ctx.fillText(`${dateStr}  ${timeStr}`, timeAnchor, cardY + Math.round(headerH * 0.65), qrSize + 40);

    const qrX = isAr ? cardX + innerPad : cardX + cardWidth - qrSize - innerPad;
    const qrY = cardY + headerH + innerPad;
    drawQrBox(ctx, qrSize, qrX, qrY);

    const textX0 = isAr ? cardX + cardWidth - innerPad : cardX + innerPad;
    drawRows(ctx, rows, textX0, isAr ? 'right' : 'left', isAr ? 'rtl' : 'ltr', cardY + headerH + innerPad + fontSecondary * 0.8, textMaxWidth + 20);
  }

  function drawMinimalStamp(ctx, width, height, isAr) {
    const outerPadding = width * 0.03;
    const cardX = outerPadding;
    const cardWidth = width - outerPadding * 2;
    const innerPad = Math.round(width * 0.03);
    const fontMain = Math.round(width * 0.026);
    const fontSecondary = Math.round(width * 0.018);
    const cardHeight = Math.round(fontMain * 2.6);
    const cardY = height - cardHeight - outerPadding;
    const textMaxWidth = cardWidth * 0.62;

    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(56,189,248,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const leftAnchor = isAr ? cardX + cardWidth - innerPad : cardX + innerPad;
    ctx.textAlign = isAr ? 'right' : 'left';
    ctx.direction = isAr ? 'rtl' : 'ltr';
    ctx.font = `bold ${fontMain}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${currentCoords.lat.toFixed(6)}°, ${currentCoords.lng.toFixed(6)}°`, leftAnchor, cardY + fontMain + 8, textMaxWidth);
    ctx.font = `${fontSecondary}px Arial, sans-serif`;
    ctx.fillStyle = '#cbd5e1';
    const shortAddress = wrapText(ctx, currentAddress || '', textMaxWidth)[0] || '';
    ctx.fillText(shortAddress, leftAnchor, cardY + fontMain + fontSecondary + 16, textMaxWidth);

    const now = new Date();
    const rightAnchor = isAr ? cardX + innerPad : cardX + cardWidth - innerPad;
    ctx.textAlign = isAr ? 'left' : 'right';
    ctx.font = `bold ${fontSecondary}px monospace`;
    ctx.fillStyle = '#7dd3fc';
    ctx.fillText(now.toISOString().split('T')[0], rightAnchor, cardY + fontMain, cardWidth * 0.3);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(now.toTimeString().split(' ')[0], rightAnchor, cardY + fontMain + fontSecondary + 10, cardWidth * 0.3);
  }

  function drawBadgeStamp(ctx, width, height, isAr) {
    const outerPadding = width * 0.03;
    const cardWidth = Math.min(width * 0.55, 320);
    const innerPad = Math.round(width * 0.03);
    const fontMain = Math.round(width * 0.022);
    const fontSecondary = Math.round(width * 0.018);
    const lineHeightSm = Math.round(fontSecondary * 1.4);

    ctx.font = `${fontSecondary}px Arial, sans-serif`;
    const textMaxWidth = cardWidth - innerPad * 2;
    const addressLines = wrapText(ctx, currentAddress || '', textMaxWidth).slice(0, 2);
    const now = new Date();

    const rows = [];
    rows.push({ text: I18nEngine.t('gps_seal'), font: `bold ${fontMain}px Arial, sans-serif`, color: '#fbbf24', h: Math.round(fontMain * 1.3), gapBefore: 0, align: 'center' });
    addressLines.forEach(l => rows.push({ text: l, font: `${fontSecondary}px Arial, sans-serif`, color: '#e2e8f0', h: lineHeightSm, gapBefore: 4, align: 'center' }));
    rows.push({ text: `${currentCoords.lat.toFixed(6)}, ${currentCoords.lng.toFixed(6)}`, font: `bold ${fontSecondary}px monospace`, color: '#fde68a', h: lineHeightSm, gapBefore: 6, align: 'center' });
    rows.push({ text: `${I18nEngine.t('date_label')} ${now.toISOString().split('T')[0]}  ${I18nEngine.t('time_label')} ${now.toTimeString().split(' ')[0]}`, font: `${Math.round(fontSecondary * 0.9)}px monospace`, color: '#94a3b8', h: lineHeightSm, gapBefore: 6, align: 'center' });

    let contentHeight = innerPad * 2 + Math.round(fontMain * 1.6);
    rows.forEach(r => { contentHeight += r.h + r.gapBefore; });
    const cardHeight = Math.min(contentHeight, height * 0.42);
    const cardX = isAr ? width - outerPadding - cardWidth : outerPadding;
    const cardY = height - cardHeight - outerPadding;

    ctx.fillStyle = 'rgba(15, 8, 2, 0.90)';
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 18);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    const cx = cardX + cardWidth / 2;
    ctx.textAlign = 'center';
    ctx.direction = isAr ? 'rtl' : 'ltr';
    ctx.font = `${Math.round(fontMain * 1.6)}px Arial, sans-serif`;
    ctx.fillStyle = '#f59e0b';
    ctx.fillText('🏅', cx, cardY + innerPad + fontMain);

    drawRows(ctx, rows, cx, 'center', isAr ? 'rtl' : 'ltr', cardY + innerPad + fontMain * 1.6, textMaxWidth + 10);
  }

  function getCompassDir() {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(currentCoords.compass / 45) % 8];
  }

  async function capturePhotoWithWatermark() {
    if (!videoElem.videoWidth) return;
    const width = videoElem.videoWidth, height = videoElem.videoHeight;
    hiddenCanvas.width = width; hiddenCanvas.height = height;
    const ctx = hiddenCanvas.getContext('2d');

    // Crop the source frame to match the live zoomed preview, so the captured photo is
    // exactly what the user saw (not a wider, unzoomed frame).
    const srcW = width / zoomLevel, srcH = height / zoomLevel;
    const srcX = (width - srcW) / 2, srcY = (height - srcH) / 2;
    ctx.drawImage(videoElem, srcX, srcY, srcW, srcH, 0, 0, width, height);

    const isAr = I18nEngine.current === 'ar';
    if (selectedTemplate === 'engineering') drawEngineeringStamp(ctx, width, height, isAr);
    else if (selectedTemplate === 'minimal') drawMinimalStamp(ctx, width, height, isAr);
    else if (selectedTemplate === 'badge') drawBadgeStamp(ctx, width, height, isAr);
    else drawClassicStamp(ctx, width, height, isAr);

    const rawDataUrl = hiddenCanvas.toDataURL('image/jpeg', 0.95);
    const stampedDataUrl = embedExifGps(rawDataUrl, currentCoords.lat, currentCoords.lng, currentCoords.alt, currentAddress);

    lastCapturedDataUrl = stampedDataUrl;
    resultPhotoImg.src = stampedDataUrl;
    resultZoomCtl.reset();
    resultSaveStatus.classList.add('hidden');
    resultSavingIndicator.classList.remove('hidden');
    openModal(modalPhotoResult);

    const base64Only = stampedDataUrl.split(',')[1];
    const fileName = `GeoSnap_${Date.now()}.jpg`;
    try {
      const saveResult = await NativeBridge.saveImage(base64Only, fileName, ALBUM_NAME);
      lastCapturedUri = saveResult.uri;
      resultSaveStatus.querySelector('span').textContent = I18nEngine.t('saved_to_gallery');
      resultSaveStatus.classList.remove('hidden', 'text-rose-400');
      resultSaveStatus.classList.add('text-emerald-400');
      refreshGalleryFromNative();
    } catch (e) {
      console.error('Save failed', e);
      resultSaveStatus.querySelector('span').textContent = I18nEngine.t('save_failed');
      resultSaveStatus.classList.remove('hidden', 'text-emerald-400');
      resultSaveStatus.classList.add('text-rose-400');
    } finally {
      resultSavingIndicator.classList.add('hidden');
    }
  }

  btnRetake.addEventListener('click', () => closeModal(modalPhotoResult));
  btnDone.addEventListener('click', () => closeModal(modalPhotoResult));

  btnShare.addEventListener('click', async () => {
    if (NativeBridge.isNative() && !lastCapturedUri) { toast(I18nEngine.t('toast_no_share')); return; }
    try {
      await NativeBridge.shareImage(lastCapturedUri, lastCapturedDataUrl, 'GeoSnap Pro');
    } catch (err) {
      if (err && err.message === 'SHARE_UNSUPPORTED') toast(I18nEngine.t('toast_no_share'));
      else console.warn('Share cancelled or failed:', err);
    }
  });

  // === 8. NATIVE GALLERY ===
  async function refreshGalleryFromNative() {
    try {
      const { items } = await NativeBridge.listImages(ALBUM_NAME, 80);
      renderGallery(items || []);
    } catch (e) {
      console.warn('listImages failed', e);
      renderGallery([]);
    }
  }

  function renderGallery(items) {
    galleryItemsCache = items;
    if (items.length > 0) {
      galleryThumbImg.src = 'data:image/jpeg;base64,' + items[0].thumbnailBase64;
      galleryThumbImg.classList.remove('hidden');
      galleryThumbIcon.classList.add('hidden');
      galleryCount.textContent = items.length;
      galleryCount.classList.remove('hidden');
      galleryEmptyHint.classList.add('hidden');
    } else {
      galleryThumbImg.classList.add('hidden');
      galleryThumbIcon.classList.remove('hidden');
      galleryCount.classList.add('hidden');
      galleryEmptyHint.classList.remove('hidden');
    }

    galleryGridContainer.innerHTML = '';
    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'relative group aspect-square rounded-2xl overflow-hidden bg-slate-900 border border-slate-800 shadow-md';
      const imgSrc = item.thumbnailBase64 ? ('data:image/jpeg;base64,' + item.thumbnailBase64) : '';
      const dateStr = item.dateAdded ? new Date(item.dateAdded).toLocaleString(I18nEngine.current === 'ar' ? 'ar-EG' : 'en-US') : '';
      card.innerHTML = `
        <img src="${imgSrc}" class="w-full h-full object-cover">
        <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent p-2 flex flex-col justify-end">
          <span class="text-[9px] text-slate-300 font-mono">${dateStr}</span>
          <button data-delete-uri="${item.uri}" class="delete-photo-btn absolute top-1.5 left-1.5 w-6 h-6 rounded-lg bg-rose-600/90 text-white flex items-center justify-center text-[10px]">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>`;
      card.addEventListener('click', () => openPhotoViewer(item));
      galleryGridContainer.appendChild(card);
    });

    document.querySelectorAll('.delete-photo-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const uri = e.currentTarget.dataset.deleteUri;
        try {
          await NativeBridge.deleteImage(uri);
          toast(I18nEngine.t('toast_photo_deleted'));
          refreshGalleryFromNative();
        } catch (err) { console.warn(err); }
      });
    });
  }

  btnGallery.addEventListener('click', () => { openModal(modalGallery); refreshGalleryFromNative(); });

  // === 8b. IN-APP PHOTO VIEWER (full resolution, no external Files/Gallery app needed) ===
  let viewerCurrentItem = null;
  async function openPhotoViewer(item) {
    viewerCurrentItem = item;
    openModal(modalPhotoViewer);
    viewerPhotoImg.classList.add('hidden');
    viewerZoomCtl.reset();
    viewerLoadingSpinner.classList.remove('hidden');
    viewerDateLabel.textContent = item.dateAdded ? new Date(item.dateAdded).toLocaleString(I18nEngine.current === 'ar' ? 'ar-EG' : 'en-US') : '';
    try {
      const dataUrl = await withTimeout(NativeBridge.getImageDataUrl(item.uri), 10000, 'VIEW_TIMEOUT');
      viewerPhotoImg.src = dataUrl;
      viewerPhotoImg.classList.remove('hidden');
    } catch (e) {
      console.warn('Failed to load full photo', e);
      toast(I18nEngine.t('toast_photo_view_failed'));
      closeModal(modalPhotoViewer);
    } finally {
      viewerLoadingSpinner.classList.add('hidden');
    }
  }

  btnViewerShare.addEventListener('click', async () => {
    if (!viewerCurrentItem) return;
    try {
      await NativeBridge.shareImage(viewerCurrentItem.uri, viewerPhotoImg.src, 'GeoSnap Pro');
    } catch (err) {
      if (err && err.message === 'SHARE_UNSUPPORTED') toast(I18nEngine.t('toast_no_share'));
      else console.warn('Share cancelled or failed:', err);
    }
  });

  btnViewerDelete.addEventListener('click', async () => {
    if (!viewerCurrentItem) return;
    try {
      await NativeBridge.deleteImage(viewerCurrentItem.uri);
      toast(I18nEngine.t('toast_photo_deleted'));
      closeModal(modalPhotoViewer);
      refreshGalleryFromNative();
    } catch (err) { console.warn(err); }
  });

  // === 9. SETTINGS / MORE MENU ===
  function updateLangButtonsUI() {
    document.querySelectorAll('.lang-select-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === I18nEngine.current);
    });
  }
  document.querySelectorAll('.lang-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang !== I18nEngine.current) {
        I18nEngine.toggle();
        updateLangButtonsUI();
      }
    });
  });
  btnMore.addEventListener('click', () => { updateLangButtonsUI(); openModal(modalMore); });
  document.getElementById('menu-permissions').addEventListener('click', async () => {
    closeModal(modalMore);
    const status = await ensurePermissions();
    toast(`${I18nEngine.current === 'ar' ? 'الكاميرا' : 'Camera'}: ${status.camera} | ${I18nEngine.current === 'ar' ? 'الموقع' : 'Location'}: ${status.location}`);
  });

  // === 10. PDF INSPECTION REPORT ===
  async function generatePdfReport() {
    const { items } = await NativeBridge.listImages(ALBUM_NAME, 200);
    if (!items || items.length === 0) { toast(I18nEngine.t('toast_pdf_empty')); return; }
    toast(I18nEngine.t('toast_pdf_generating'));

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();

    doc.setFontSize(20);
    doc.text(I18nEngine.t('report_title'), pageW / 2, 100, { align: 'center' });
    doc.setFontSize(11);
    let y = 140;
    if (projectState.projectName) { doc.text(`${I18nEngine.t('project_name_label')} ${projectState.projectName}`, 60, y); y += 20; }
    if (projectState.inspectorName) { doc.text(`${I18nEngine.t('inspector_name_label')} ${projectState.inspectorName}`, 60, y); y += 20; }
    if (projectState.siteId) { doc.text(`${I18nEngine.t('site_id_label')} ${projectState.siteId}`, 60, y); y += 20; }
    if (projectState.notes) { doc.text(`${I18nEngine.t('notes_field_label')} ${projectState.notes}`, 60, y); y += 20; }
    doc.text(`${I18nEngine.t('report_generated_on')}: ${new Date().toLocaleString()}`, 60, y + 10);
    doc.text(`${I18nEngine.current === 'ar' ? 'عدد الصور' : 'Total Photos'}: ${items.length}`, 60, y + 30);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      doc.addPage();
      doc.setFontSize(13);
      doc.text(`${I18nEngine.t('report_photo_no')} ${i + 1}`, 60, 50);

      if (item.thumbnailBase64) {
        try {
          const imgData = 'data:image/jpeg;base64,' + item.thumbnailBase64;
          const imgW = pageW - 120;
          const imgH = imgW * 0.66;
          doc.addImage(imgData, 'JPEG', 60, 70, imgW, imgH);
        } catch (e) { console.warn('addImage failed', e); }
      }

      doc.setFontSize(10);
      let ty = 70 + (pageW - 120) * 0.66 + 30;
      if (item.address) { doc.text(`${I18nEngine.t('location_label')} ${item.address}`, 60, ty); ty += 18; }
      if (item.lat && item.lng) { doc.text(`${I18nEngine.t('coords_label')} ${item.lat.toFixed(6)}, ${item.lng.toFixed(6)}`, 60, ty); ty += 18; }
      if (item.dateAdded) { doc.text(`${new Date(item.dateAdded).toLocaleString()}`, 60, ty); }
    }

    const pdfBase64 = doc.output('datauristring').split(',')[1];
    try {
      await NativeBridge.saveDocument(pdfBase64, `GeoSnap_Report_${Date.now()}.pdf`);
      toast(I18nEngine.t('toast_pdf_done'));
    } catch (e) {
      console.error(e);
    }
  }
  document.getElementById('menu-report').addEventListener('click', () => { closeModal(modalMore); generatePdfReport(); });
  document.getElementById('btn-gallery-report').addEventListener('click', generatePdfReport);

  // === 11. HARDWARE / GESTURE BACK BUTTON ===
  // On the camera screen the OS back button used to exit the app immediately. Now it closes
  // whichever modal is open first (so "back" feels like real in-app navigation), and only
  // exits from the main camera screen, requiring a second press within 2s to confirm.
  const backCloseableModals = [modalPhotoViewer, modalLocationFix, modalPhotoResult, modalTemplates, modalProject, modalGallery, modalMore];
  let lastBackPressAt = 0;

  function handleBackNavigation() {
    for (const modal of backCloseableModals) {
      if (modal && !modal.classList.contains('hidden')) {
        closeModal(modal);
        return;
      }
    }
    const now = Date.now();
    if (now - lastBackPressAt < 2000) {
      const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (AppPlugin && AppPlugin.exitApp) AppPlugin.exitApp();
    } else {
      lastBackPressAt = now;
      toast(I18nEngine.t('exit_confirm'));
    }
  }

  if (NativeBridge.isNative() && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.addListener('backButton', handleBackNavigation);
  }

  // === 12. INIT ===
  (async function init() {
    restoreUiState();
    applySelectedTemplateUI();
    applyProjectStateUI();
    initMiniMap();
    updateGalleryUIPlaceholder();
    const status = await ensurePermissions();
    if (status.camera === 'granted') await initCamera();
    if (status.location === 'granted' || NativeBridge.isNative() === false) startLocationTracking();
    if (status.camera !== 'granted' || status.location !== 'granted') {
      // Proactively ask once on first launch for a smoother experience.
      await requestPermissionsFlow();
    }
    refreshGalleryFromNative();
  })();

  function updateGalleryUIPlaceholder() {
    galleryThumbIcon.classList.remove('hidden');
    galleryThumbImg.classList.add('hidden');
    galleryCount.classList.add('hidden');
  }
});
