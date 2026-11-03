// Face recognition helpers built on face-api.js. Runs entirely in the browser;
// the models are served from this laptop (/models), so no internet is needed.
const Face = {
  loaded: false,
  async load() {
    if (Face.loaded) return;
    if (typeof faceapi === 'undefined') throw new Error('Face library did not load. Run `npm install` again.');
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]);
    Face.loaded = true;
  },
  async startCamera(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera is not available. Open the app at http://localhost:3000 in Chrome, Edge or Firefox.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    await new Promise((r) => { video.onloadedmetadata = r; });
    await video.play();
    return stream;
  },
  stopCamera(video) {
    const s = video && video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    if (video) video.srcObject = null;
  },
  options() { return new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }); },
  // Returns { count, detection } where detection has .descriptor (128 numbers) when exactly one face is visible.
  async detect(video) {
    const all = await faceapi.detectAllFaces(video, Face.options()).withFaceLandmarks().withFaceDescriptors();
    if (all.length !== 1) return { count: all.length, detection: all[0] || null, all };
    return { count: 1, detection: all[0], all };
  },
  // Draws boxes on an overlay canvas sized to the video.
  draw(canvas, video, detections, color = '#2ecc71', label = '') {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w) return;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    for (const d of detections || []) {
      const b = d.detection ? d.detection.box : d.box;
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.strokeRect(b.x, b.y, b.width, b.height);
      if (label) {
        // canvas is mirrored with CSS, so mirror text back
        ctx.save(); ctx.scale(-1, 1);
        ctx.font = 'bold 18px system-ui'; ctx.fillStyle = color;
        ctx.fillText(label, -(b.x + b.width), Math.max(18, b.y - 8));
        ctx.restore();
      }
    }
  },
  // Collects several good samples of one face for enrolment.
  async captureSamples(video, canvas, n, onProgress) {
    const out = [];
    let tries = 0;
    while (out.length < n && tries < 150) {
      tries++;
      const r = await Face.detect(video);
      Face.draw(canvas, video, r.all, r.count === 1 ? '#2ecc71' : '#e74c3c');
      if (r.count === 0) onProgress(out.length, 'No face found. Look at the camera, with good light on your face.');
      else if (r.count > 1) onProgress(out.length, 'More than one face visible. Only you should be in the frame.');
      else if (r.detection.detection.score < 0.6) onProgress(out.length, 'Move a little closer to the camera.');
      else {
        out.push(Array.from(r.detection.descriptor));
        onProgress(out.length, out.length < n ? 'Good! Turn your head slightly and hold still…' : 'Done!');
        await new Promise((res) => setTimeout(res, 450));
      }
      await new Promise((res) => setTimeout(res, 120));
    }
    if (out.length < n) throw new Error('Could not capture your face clearly. Improve the lighting and try again.');
    return out;
  },
};
