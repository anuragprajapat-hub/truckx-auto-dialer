(() => {
  if (document.getElementById('truckx-extension-marker')) return;

  const marker = document.createElement('div');
  marker.id = 'truckx-extension-marker';
  marker.hidden = true;
  marker.dataset.ready = 'true';
  document.documentElement.appendChild(marker);
})();
