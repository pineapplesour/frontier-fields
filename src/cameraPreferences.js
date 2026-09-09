// Camera/UI preference only; no strategic observations or unit history is stored.
const key = "fieldline-camera-v2";
export function readCamera() {
  try {
    const p = JSON.parse(sessionStorage.getItem(key));
    if (
      p &&
      [p.position, p.target].every(
        (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite),
      ) &&
      p.zoom >= 0.65 &&
      p.zoom <= 5
    )
      return p;
  } catch {}
  return null;
}
export function saveCamera(camera, controls) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        zoom: camera.zoom,
      }),
    );
  } catch {}
}
