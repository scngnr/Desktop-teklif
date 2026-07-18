# Desktop Teklif

MRP API’den sonraki teklif numarasını alıp Masaüstündeki **örnek klasör**ü kopyalayan Electron uygulaması.

## Ne yapar?

1. `GET https://mrp.cangungor.tr/api/teklif/last_number` (header: `authtoken`)
2. Sonraki teklif no: `proposal_prefix` + bugünün tarihi (`ddmmyy`) + `-` + (`last_proposal_id` + 1)
3. Örnek klasörü Masaüstüne bu isimle kopyalar
4. `4-Teklif` içindeki `Yeni Teklif V1.21.*` Excel dosyalarını teklif adıyla yeniden adlandırır

## Çalıştırma

```bash
npm install
npm start
```

## Klasör yapısı

```
Desktop-teklif/
  main.js
  preload.js
  index.html
  renderer.js
  styles.css
  package.json
  src/
    config.js
    mrpApi.js
    folderService.js
```

## Notlar

- Örnek klasör önce `Desktop\örnek klasör`, yoksa proje kökündeki kopya aranır.
- Auth token şu an VBA örnek sabitiyle `src/config.js` içinde sabitlenmiştir.
