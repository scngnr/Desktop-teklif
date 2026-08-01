# Desktop Teklif

MRP API’den teklif numarası alıp Masaüstüne klasör oluşturan Electron uygulaması. Panel ekranı MRP web arayüzünü webview ile gösterir.

## Kurulum (5 adım)

1. `npm install`
2. `npm start`
3. **Ayarlar** ekranında:
   - **Base URL:** örn. `https://mrp.cangungor.tr`
   - **Firma adı:** (varsa) URL yolu için slug — `base/firma/ps/admin`
   - **JWT Token:** MRP API token’ınız (kaynak kodda varsayılan token yok)
4. **Kaydet**
5. Sidebar’dan **Yeni Teklif** veya **Panel**

## Çalıştırma / Build

```bash
npm start          # geliştirme
npm run dist       # Windows portable exe → dist/
```

## Ne yapar?

1. `GET /api/teklif/last_number` (`authtoken` header)
2. Sonraki teklif no: `proposal_prefix` + `ddmmyy` + `-` + (`last_proposal_id` + 1)
3. API’ye teklif kaydı (`create_safe` / `api/teklif`)
4. Örnek klasörü Masaüstüne teklif adıyla kopyalar; `4-Teklif` Excel dosyalarını yeniden adlandırır
5. Son teklifleri sidebar’da listeler (klasöre tıklayınca açılır)

## Notlar

- JWT yalnızca `%AppData%` altındaki `settings.json` içinde saklanır; repoda sabit token yoktur.
- **Yeni Teklif** butonu yalnızca JWT + [teklif sunucu](https://nextjs-teklif-sunucu.vercel.app/api-referans/) lisansı (`GET /api/license/{mac}/`, `license: true`) ile açılır. Kayıt yoksa MAC ile `POST /api/license/` başvurusu yapılır.
- Örnek klasör: önce `Desktop\örnek klasör`, yoksa paket içi kopya.
- Giriş yapılmış web oturumunda sidebar gizlenir; **Yeni Teklif** sağ alt FAB olur.
- Titlebar firma adı, `/admin/api/api_guide` login sayfasından okunur.

## Excel VBA — JWT’yi Desktop Teklif’ten okuma

Ayarlardaki JWT dosyası: `%AppData%\desktop-teklif\settings.json` (`authToken`).

1. `vba/MrpApi_DesktopTeklifSettings.bas` dosyasını Excel VBA projesine **Import** edin  
2. `MrpApi` içinde `EXAMPLE_JWT` değerini boşaltın  
3. `MrpApi_Example_Configure` gövdesini `vba/MrpApi_Example_Configure_Replace.txt` ile değiştirin  
4. Immediate: `MrpApi_Example_Configure` → `? MrpApi_IsConfigured`

## Repo

https://github.com/scngnr/Desktop-teklif
