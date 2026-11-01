// esri-leaflet 3.0.19 retains detached images and its asynchronous image
// callbacks dereference a map that can already be null. These layers use
// Leaflet's standard Web Mercator image overlay; keep ownership explicit.
export function guardRasterLayer(L, layer) {
  const pending = new Set();
  const onRemove = layer.onRemove;
  layer.onRemove = function (map) {
    for (const image of pending) {
      image.off('load error');
      map.removeLayer(image);
    }
    pending.clear();
    onRemove.call(this, map);
    this._currentImage = null;
  };
  layer._renderImage = function (url, bounds, contentType) {
    const map = this._map;
    if (!map || !url) return;
    if (contentType) url = `data:${contentType};base64,${url}`;
    const image = L.imageOverlay(url, bounds, {
      opacity: 0,
      crossOrigin: this.options.withCredentials ? 'use-credentials' : this.options.useCors,
      alt: this.options.alt,
      pane: this.options.pane || this.getPane(),
      interactive: this.options.interactive,
    });
    pending.add(image);
    const cleanup = () => { pending.delete(image); image.off('load error'); };
    image.once('error', () => {
      cleanup();
      map.removeLayer(image);
      if (this._map === map) this.fire('error');
    });
    image.once('load', () => {
      cleanup();
      if (this._map !== map || !map.hasLayer(image) || !bounds.equals(map.getBounds())) {
        map.removeLayer(image);
        return;
      }
      const old = this._currentImage;
      this._currentImage = image;
      image.setOpacity(this.options.opacity);
      if (this.options.position === 'front') image.bringToFront();
      else if (this.options.position === 'back') image.bringToBack();
      if (this.options.zIndex != null) image.setZIndex(this.options.zIndex);
      if (old && old !== image) map.removeLayer(old);
      this.fire('load', { bounds });
    });
    return image.addTo(map);
  };
  return layer;
}
