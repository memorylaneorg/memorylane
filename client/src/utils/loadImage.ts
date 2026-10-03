/** Load and decode a viewer image without replacing its cached preview early. */
export function loadImage(src: string, onReady: () => void, onError: () => void): () => void {
  let active = true;
  const image = new Image();
  image.onload = () => {
    void image.decode().then(
      () => { if (active) onReady(); },
      () => { if (active) onError(); },
    );
  };
  image.onerror = () => { if (active) onError(); };
  image.src = src;
  return () => {
    active = false;
    image.onload = null;
    image.onerror = null;
    // Stop a pending request when navigating away; late decode completions
    // are also ignored through the active guard above.
    image.src = "";
  };
}
