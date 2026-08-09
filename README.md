# Desktop Teklif

MRP API’den teklif numarası alıp Masaüstüne klasör oluşturan Electron uygulaması. Panel ekranı MRP web arayüzünü webview ile gösterir.

## Kurulum (5 adım)

1. Bağımlılıkları kurun: `npm install`
2. Uygulamayı açın: `npm start`  
   (hazır paket: `npm run dist` → `dist/Desktop-Teklif--portable.exe`)
3. İlk açılışta **Ayarlar** zorunludur. Doldurun:
   - **Base URL:** örn. `https://mrp.cangungor.tr`
   - **Firma adı:** (varsa) giriş yolu için slug → `base/firma/ps/admin`
   - **JWT Token:** MRP API token’ı (kaynak kodda varsayılan token **yok**)
   - İsteğe bağlı: **ekran sağ altında Yeni Teklif butonu**
4. **Kaydet** — lisans kontrolü otomatik çalışır (MAC → teklif sunucu)
5. **Yeni Teklif** ile oluşturun veya **Panel** ile MRP web arayüzüne geçin

### Ayarlar özeti

| Alan | Ne için |
|------|---------|
| Base URL | API ve web kök adresi |
| Firma adı | Giriş/panel: `{base}/{firma}/ps/admin` (boşsa `{base}/admin`) |
| JWT | `authtoken` header; yalnızca `%AppData%\desktop-teklif\settings.json` |
| Masaüstü FAB | Uygulama açıkken sağ altta yüzen buton → masaüstü teklif formu |

Örnek klasör: önce `Desktop\örnek klasör`, yoksa paket içi kopya (`örnek klasör`).

## Çalıştırma / Build

```bash
npm start          # geliştirme
npm run dist       # Windows portable exe → dist/
```

İkon: `build/icon.ico` (Windows) / `build/icon.png`.

## Ne yapar?

1. `GET /api/teklif/last_number` (`authtoken` header)
2. Sonraki teklif no: `proposal_prefix` + `ddmmyy` + `-` + (`last_proposal_id` + 1)
3. Onay modalında müşteri / kişi / proje seçimi + teklif no önizlemesi
4. API’ye teklif kaydı (`create_safe` / `api/teklif`)
5. Örnek klasörü Masaüstüne kopyalar; `4-Teklif` Excel adlarını eşler
6. Başarı toast’ında **Klasörü Aç**; sidebar’da son teklifler

## Notlar

- JWT yalnızca `%AppData%` altındaki `settings.json` içinde saklanır; repoda sabit token yoktur.
- **Yeni Teklif** yalnızca JWT + [teklif sunucu](https://nextjs-teklif-sunucu.vercel.app/api-referans/) lisansı (`license: true`) ile açılır.
- Web oturumunda sidebar gizlenir; uygulama içi **Yeni Teklif** sağ alt FAB olur.
- Masaüstü FAB (Ayarlar’dan) tıklanınca ana pencere yerine masaüstü modal açılır.
- Oluşturma sırasında butonlar **Oluşturuluyor…** ile kilitlenir (çift tıklama engeli).

## Excel VBA — JWT / baseUrl Desktop Teklif’ten

Tek dosya: `vba/MrpApi.bas`

1. Excel VBA’da eski `MrpApi` modülünü kaldırın (varsa)
2. `vba/MrpApi.bas` dosyasını **Import** edin
3. Immediate: `MrpApi_Example_Configure` → `? MrpApi_IsConfigured`

`settings.json` alanları: `baseUrl`, `authToken` (ve uygulama tarafında `firmaAdi`).

## Repo

https://github.com/scngnr/Desktop-teklif
