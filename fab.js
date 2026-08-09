const btn = document.getElementById('btnFab');
const label = document.getElementById('label');

function setEnabled(enabled) {
  btn.disabled = !enabled;
  btn.title = enabled
    ? 'Yeni Teklif Oluştur'
    : 'JWT veya lisans eksik — ana uygulamadan Ayarlar’ı kontrol edin';
}

btn.addEventListener('click', () => {
  if (btn.disabled) return;
  window.teklifFab.click();
});

window.teklifFab.onState((state) => {
  if (!state) return;
  setEnabled(!!state.enabled);
  if (state.busy) {
    label.textContent = 'Oluşturuluyor…';
  } else {
    label.textContent = 'Yeni Teklif';
  }
});

window.teklifFab.ready();
