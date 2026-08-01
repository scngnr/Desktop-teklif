Attribute VB_Name = "MrpApi"
'================================================================================
' Perfex CRM / MRP API — Ürün, BOM, Teklif
' Referans: api/product, api/bom, api/teklif, api/teklif/last_number, api/teklif/company, api/teklif/companies_contacts, api/teklif/firma_upsert
'
' Kurulum:
'   1. VBA editöründe bu modülü içe aktarın veya yapıştırın.
'   2. Desktop Teklif > Ayarlar'dan baseUrl + JWT kaydedin.
'   3. MrpApi_Example_Configure  veya  MrpApi_ConfigureFromDesktopTeklif
'      (%APPDATA%\desktop-teklif\settings.json — baseUrl + authToken).
'   4. Gerekirse manuel: MrpApi_Configure "https://...", "JWT"
'   5. Sonuçlar: MrpApi_LastHttpStatus / MrpApi_LastResponseBody
'
' Kimlik doğrulama (REST_Controller + Authorization_Token):
'   • HTTP başlığı adı: modules/api/config/jwt.php -> token_header (varsayılan "authtoken")
'   • Değer: Admin > Kurulum > API kullanıcısı kaydedildikten sonra görünen JWT (uzun metin).
'     Bu, veritabanındaki token ile birebir aynıdır; kullanıcı adı veya şifre gönderilmez.
'   • Başlık adını sunucuda değiştirdiyseniz: MrpApi_SetAuthHeader "yeni_ad"
'================================================================================

Option Explicit

Private m_BaseUrl As String
Private m_ApiToken As String
Private m_AuthHeaderName As String
Private m_LastHttpStatus As Long
Private m_LastResponseBody As String
Private m_LastRequestUrl As String

' Örnek prosedürler için — VBA kuralı: tüm modül düzeyi Const/Dim, ilk Sub/Function ÖNCESİ olmalıdır.
Private Const FALLBACK_BASE_URL As String = "https://mrp.cangungor.tr"
' JWT + baseUrl: %APPDATA%\desktop-teklif\settings.json (authToken, baseUrl)

' baseUrl: https://mrp.cangungor.tr  |  jwtToken: API kullanıcısı oluşturulunca üretilen JWT tam metni
Public Sub MrpApi_Configure(ByVal baseUrl As String, ByVal jwtToken As String)
    m_BaseUrl = RTrim$(baseUrl)
    ' Saha yazim hatasi korumasi: rmp -> mrp
    If InStr(1, LCase$(m_BaseUrl), "://rmp.cangungor.tr", vbTextCompare) > 0 Then
        m_BaseUrl = Replace(m_BaseUrl, "://rmp.cangungor.tr", "://mrp.cangungor.tr", 1, -1, vbTextCompare)
    End If
    If Len(m_BaseUrl) > 0 Then
        If Right$(m_BaseUrl, 1) = "/" Then m_BaseUrl = Left$(m_BaseUrl, Len(m_BaseUrl) - 1)
    End If
    m_ApiToken = Trim$(jwtToken)
    If Len(m_AuthHeaderName) = 0 Then m_AuthHeaderName = "authtoken"
End Sub

' jwt.php içinde token_header farklıysa (ör. "Authorization") buradan ayarlayın.
Public Sub MrpApi_SetAuthHeader(ByVal headerName As String)
    m_AuthHeaderName = LCase$(Trim$(headerName))
End Sub

' MrpApi_Configure en az bir kez çağrıldı mı (MrpApi_Teklif* vb. öncesi gerekir).
Public Function MrpApi_IsConfigured() As Boolean
    MrpApi_IsConfigured = (Len(m_BaseUrl) > 0 And Len(m_ApiToken) > 0)
End Function

'================================================================================
' Desktop Teklif — %APPDATA%\desktop-teklif\settings.json
'================================================================================

Public Function MrpApi_DesktopTeklifSettingsPath() As String
    MrpApi_DesktopTeklifSettingsPath = Environ$("APPDATA") & "\desktop-teklif\settings.json"
End Function

Private Function MrpApi_DesktopTeklifReadFile() As String
    Dim p As String
    Dim f As Integer
    Dim txt As String

    MrpApi_DesktopTeklifReadFile = vbNullString
    p = MrpApi_DesktopTeklifSettingsPath()
    If Len(Dir$(p)) = 0 Then Exit Function

    On Error GoTo Fail
    f = FreeFile
    Open p For Binary Access Read As #f
    If LOF(f) > 0 Then
        txt = String$(LOF(f), vbNullChar)
        Get #f, , txt
    End If
    Close #f

    If Left$(txt, 3) = Chr$(239) & Chr$(187) & Chr$(191) Then
        txt = Mid$(txt, 4)
    End If
    MrpApi_DesktopTeklifReadFile = txt
    Exit Function
Fail:
    On Error Resume Next
    Close #f
    MrpApi_DesktopTeklifReadFile = vbNullString
End Function

' "key": "value" — arada bosluk olabilir
Private Function MrpApi_JsonString(ByVal json As String, ByVal key As String) As String
    Dim pat As String
    Dim p As Long
    Dim q As Long
    Dim ch As String

    MrpApi_JsonString = vbNullString
    pat = """" & key & """"
    p = InStr(1, json, pat, vbTextCompare)
    If p = 0 Then Exit Function
    p = p + Len(pat)

    Do While p <= Len(json)
        ch = Mid$(json, p, 1)
        If ch = " " Or ch = vbTab Or ch = vbCr Or ch = vbLf Or ch = ":" Then
            p = p + 1
        Else
            Exit Do
        End If
    Loop

    If p > Len(json) Then Exit Function
    If Mid$(json, p, 1) <> """" Then Exit Function
    p = p + 1

    q = p
    Do While q <= Len(json)
        ch = Mid$(json, q, 1)
        If ch = """" Then
            If Mid$(json, q - 1, 1) <> "\" Then Exit Do
        End If
        q = q + 1
    Loop
    If q <= p Then Exit Function
    MrpApi_JsonString = Mid$(json, p, q - p)
End Function

Private Function MrpApi_NormalizeBaseUrl(ByVal u As String) As String
    u = Trim$(u)
    If Len(u) = 0 Then u = FALLBACK_BASE_URL
    If InStr(1, LCase$(u), "://rmp.cangungor.tr", vbTextCompare) > 0 Then
        u = Replace(u, "://rmp.cangungor.tr", "://mrp.cangungor.tr", 1, -1, vbTextCompare)
    End If
    Do While Right$(u, 1) = "/"
        u = Left$(u, Len(u) - 1)
    Loop
    MrpApi_NormalizeBaseUrl = u
End Function

' settings.json -> MrpApi_Configure. JWT yoksa False.
Public Function MrpApi_ConfigureFromDesktopTeklif() As Boolean
    Dim js As String
    Dim jwt As String
    Dim url As String

    js = MrpApi_DesktopTeklifReadFile()
    If Len(js) = 0 Then
        MrpApi_ConfigureFromDesktopTeklif = False
        Exit Function
    End If

    jwt = Trim$(MrpApi_JsonString(js, "authToken"))
    url = MrpApi_NormalizeBaseUrl(MrpApi_JsonString(js, "baseUrl"))

    If Len(jwt) = 0 Then
        MrpApi_ConfigureFromDesktopTeklif = False
        Exit Function
    End If

    MrpApi_Configure url, jwt
    MrpApi_ConfigureFromDesktopTeklif = True
End Function


Public Function MrpApi_LastHttpStatus() As Long
    MrpApi_LastHttpStatus = m_LastHttpStatus
End Function

Public Function MrpApi_LastResponseBody() As String
    MrpApi_LastResponseBody = m_LastResponseBody
End Function

Public Function MrpApi_LastRequestUrl() As String
    MrpApi_LastRequestUrl = m_LastRequestUrl
End Function

' Token bilgisini JWT payload'dan lokal decode eder (HTTP cagrisi yok).
' Donen JSON icinde user, name, API_TIME alanlari bulunur.
Public Function MrpApi_TokenOwnerInfo() As String
    Dim parts() As String
    Dim payloadJson As String

    m_LastHttpStatus = 0
    m_LastResponseBody = vbNullString
    MrpApi_TokenOwnerInfo = vbNullString

    If Len(m_ApiToken) = 0 Then
        m_LastResponseBody = "{""status"":false,""message"":""MrpApi_Configure ile token ayarlayin""}"
        Exit Function
    End If

    parts = Split(m_ApiToken, ".")
    If UBound(parts) < 1 Then
        m_LastResponseBody = "{""status"":false,""message"":""Gecersiz JWT token""}"
        Exit Function
    End If

    payloadJson = MrpApi_Base64UrlDecodeToUtf8(parts(1))
    If Len(payloadJson) = 0 Then
        m_LastResponseBody = "{""status"":false,""message"":""JWT payload decode edilemedi""}"
        Exit Function
    End If

    m_LastHttpStatus = 200
    m_LastResponseBody = payloadJson
    MrpApi_TokenOwnerInfo = payloadJson
End Function

' Token sahibinin ad-soyad bilgisi (result.user_data.name).
' Bulunamazsa bos dize dondurur.
Public Function MrpApi_TokenOwnerName() As String
    Dim js As String
    MrpApi_TokenOwnerName = vbNullString
    js = MrpApi_TokenOwnerInfo()
    If MrpApi_LastHttpStatus() <> 200 Then Exit Function
    MrpApi_TokenOwnerName = MrpApi_JsonParseString(js, "name")
    If Len(MrpApi_TokenOwnerName) = 0 Then
        MrpApi_TokenOwnerName = MrpApi_JsonParseString(js, "user")
    End If
End Function

Private Function MrpApi_Base64UrlDecodeToUtf8(ByVal s As String) As String
    Dim b64 As String
    Dim pad As Long
    Dim dom As Object
    Dim el As Object
    Dim bytes As Variant
    Dim stm As Object

    On Error GoTo Fail

    b64 = Replace(s, "-", "+")
    b64 = Replace(b64, "_", "/")
    pad = (4 - (Len(b64) Mod 4)) Mod 4
    If pad > 0 Then b64 = b64 & String$(pad, "=")

    Set dom = CreateObject("MSXML2.DOMDocument.6.0")
    Set el = dom.createElement("b64")
    el.DataType = "bin.base64"
    el.Text = b64
    bytes = el.nodeTypedValue

    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 1
    stm.Open
    stm.Write bytes
    stm.Position = 0
    stm.Type = 2
    stm.Charset = "utf-8"
    MrpApi_Base64UrlDecodeToUtf8 = stm.ReadText
    stm.Close
    Set stm = Nothing
    Set el = Nothing
    Set dom = Nothing
    Exit Function

Fail:
    MrpApi_Base64UrlDecodeToUtf8 = vbNullString
End Function

' --- Ürün (api/product) ---

Public Function MrpApi_ProductGet(Optional ByVal productId As Variant) As String
    If IsMissing(productId) Or IsEmpty(productId) Or Len(Trim$(CStr(productId))) = 0 Then
        MrpApi_ProductGet = MrpApi_Request("GET", "api/product", vbNullString)
    Else
        MrpApi_ProductGet = MrpApi_Request("GET", "api/product/" & CStr(productId), vbNullString)
    End If
End Function

Public Function MrpApi_ProductCreate(ByVal jsonBody As String) As String
    MrpApi_ProductCreate = MrpApi_Request("POST", "api/product", jsonBody)
End Function

' Toplu: POST api/product — gövde {"products":[{...},{...}]} (sunucu başına en fazla ~150 kalem; Product.php PRODUCT_BULK_MAX_ITEMS)
Public Function MrpApi_ProductCreateBulk(ByVal jsonBody As String) As String
    MrpApi_ProductCreateBulk = MrpApi_RequestBulk("POST", "api/product", jsonBody)
End Function

Public Function MrpApi_ProductUpdate(ByVal productId As Long, ByVal jsonBody As String) As String
    MrpApi_ProductUpdate = MrpApi_Request("PUT", "api/product/" & CStr(productId), jsonBody)
End Function

' --- BOM (api/bom) ---

Public Function MrpApi_BomGet(Optional ByVal bomId As Variant) As String
    If IsMissing(bomId) Or IsEmpty(bomId) Or Len(Trim$(CStr(bomId))) = 0 Then
        MrpApi_BomGet = MrpApi_Request("GET", "api/bom", vbNullString)
    Else
        MrpApi_BomGet = MrpApi_Request("GET", "api/bom/" & CStr(bomId), vbNullString)
    End If
End Function

Public Function MrpApi_BomCreate(ByVal jsonBody As String) As String
    MrpApi_BomCreate = MrpApi_Request("POST", "api/bom", jsonBody)
End Function

Public Function MrpApi_BomUpdate(ByVal bomId As Long, ByVal jsonBody As String) As String
    MrpApi_BomUpdate = MrpApi_Request("PUT", "api/bom/" & CStr(bomId), jsonBody)
End Function

' --- Teklif (api/teklif) ---

Public Function MrpApi_TeklifGet(Optional ByVal teklifId As Variant) As String
    If IsMissing(teklifId) Or IsEmpty(teklifId) Or Len(Trim$(CStr(teklifId))) = 0 Then
        MrpApi_TeklifGet = MrpApi_Request("GET", "api/teklif", vbNullString)
    Else
        MrpApi_TeklifGet = MrpApi_Request("GET", "api/teklif/" & CStr(teklifId), vbNullString)
    End If
End Function

Public Function MrpApi_TeklifCreate(ByVal jsonBody As String) As String
    Dim resp As String
    resp = MrpApi_Request("POST", "api/teklif/create_safe", jsonBody)

    ' Eski/henüz güncellenmemiş sunucularda create_safe route olmayabilir.
    ' 404/405 veya "Unknown method" durumunda klasik endpoint'e düş.
    If m_LastHttpStatus = 404 Or m_LastHttpStatus = 405 _
       Or InStr(1, resp, "Unknown method", vbTextCompare) > 0 Then
        ' Fallback'i prosedür içinde form-data ile yapıyoruz.
        MrpApi_TeklifCreate = resp
        Exit Function
    End If

    MrpApi_TeklifCreate = resp
End Function

Public Function MrpApi_TeklifWorkbookSubmit(ByVal jsonBody As String) As String
    Dim resp As String
    resp = MrpApi_RequestBulk("POST", "api/teklif/workbook_submit", jsonBody)
    If MrpApi_LastHttpStatus() = 404 Then
        resp = MrpApi_RequestBulk("POST", "index.php/api/teklif/workbook_submit", jsonBody)
    End If
    If (MrpApi_LastHttpStatus() = 404 Or MrpApi_LastHttpStatus() = 405 _
        Or InStr(1, resp, "Unknown method", vbTextCompare) > 0) Then
        resp = MrpApi_RequestBulk("POST", "api/teklif/workbooksubmit", jsonBody)
    End If
    If MrpApi_LastHttpStatus() = 404 Then
        resp = MrpApi_RequestBulk("POST", "index.php/api/teklif/workbooksubmit", jsonBody)
    End If
    MrpApi_TeklifWorkbookSubmit = resp
End Function

Public Function MrpApi_TeklifWorkbookImport(ByVal jsonBody As String, Optional ByVal wbSectionsPayloadB64url As String = vbNullString) As String
    Dim resp As String
    resp = MrpApi_Request("POST", "api/teklif/workbook_import", jsonBody, wbSectionsPayloadB64url)
    If m_LastHttpStatus = 400 And (InStr(1, resp, "subject and company are required", vbTextCompare) > 0 _
        Or InStr(1, resp, "sections[] is required", vbTextCompare) > 0) Then
        resp = MrpApi_TeklifWorkbookImportPayloadForm(jsonBody, wbSectionsPayloadB64url)
    End If
    If m_LastHttpStatus = 400 And InStr(1, resp, "subject and company are required", vbTextCompare) > 0 Then
        resp = MrpApi_TeklifWorkbookImportForm(jsonBody, wbSectionsPayloadB64url)
    End If
    If MrpApi_LastHttpStatus() = 404 Then
        resp = MrpApi_Request("POST", "index.php/api/teklif/workbook_import", jsonBody, wbSectionsPayloadB64url)
    End If
    If (MrpApi_LastHttpStatus() = 404 Or MrpApi_LastHttpStatus() = 405 _
        Or InStr(1, resp, "Unknown method", vbTextCompare) > 0) Then
        resp = MrpApi_Request("POST", "api/teklif/workbookimport", jsonBody, wbSectionsPayloadB64url)
    End If
    If MrpApi_LastHttpStatus() = 404 Then
        resp = MrpApi_Request("POST", "index.php/api/teklif/workbookimport", jsonBody, wbSectionsPayloadB64url)
    End If
    MrpApi_TeklifWorkbookImport = resp
End Function

Private Function MrpApi_TeklifWorkbookImportPayloadForm(ByVal jsonBody As String, Optional ByVal wbSectionsPayloadB64url As String = vbNullString) As String
    Dim formBody As String
    Dim p As String
    p = MrpApi_Base64UrlEncodeUtf8(jsonBody)
    formBody = "payload_b64url=" & MrpApi_UrlEncode(p) & "&p=" & MrpApi_UrlEncode(p)
    If Len(Trim$(wbSectionsPayloadB64url)) > 0 Then
        formBody = formBody & "&wb=" & MrpApi_UrlEncode(wbSectionsPayloadB64url)
    End If
    MrpApi_TeklifWorkbookImportPayloadForm = MrpApi_RequestForm("POST", "api/teklif/workbook_import", formBody, wbSectionsPayloadB64url)
End Function

Private Function MrpApi_TeklifWorkbookImportForm(ByVal jsonBody As String, Optional ByVal wbSectionsPayloadB64url As String = vbNullString) As String
    Dim subjectText As String
    Dim companyText As String
    Dim contactText As String
    Dim phoneText As String
    Dim emailText As String
    Dim formBody As String

    subjectText = MrpApi_JsonParseString(jsonBody, "subject")
    companyText = MrpApi_JsonParseString(jsonBody, "company")
    contactText = MrpApi_JsonParseString(jsonBody, "contact")
    phoneText = MrpApi_JsonParseString(jsonBody, "phone")
    emailText = MrpApi_JsonParseString(jsonBody, "email")

    formBody = ""
    formBody = formBody & "subject=" & MrpApi_UrlEncode(subjectText)
    formBody = formBody & "&company=" & MrpApi_UrlEncode(companyText)
    formBody = formBody & "&contact=" & MrpApi_UrlEncode(contactText)
    formBody = formBody & "&phone=" & MrpApi_UrlEncode(phoneText)
    formBody = formBody & "&email=" & MrpApi_UrlEncode(emailText)
    ' Form alan adinda "sections" gecmesi bazi WAF'larda kirpilir; bolumler_* birincil.
    formBody = formBody & "&bolumler_json=" & MrpApi_UrlEncode(MrpApi_JsonExtractArray(jsonBody, "bolumler"))
    formBody = formBody & "&bolumler_b64url=" & MrpApi_UrlEncode(MrpApi_Base64UrlEncodeUtf8(MrpApi_JsonExtractArray(jsonBody, "bolumler")))
    formBody = formBody & "&import_sections_json=" & MrpApi_UrlEncode(MrpApi_JsonExtractArray(jsonBody, "bolumler"))
    formBody = formBody & "&sections_json=" & MrpApi_UrlEncode(MrpApi_JsonExtractArray(jsonBody, "bolumler"))
    formBody = formBody & "&sections_b64=" & MrpApi_UrlEncode(MrpApi_Base64EncodeUtf8(MrpApi_JsonExtractArray(jsonBody, "bolumler")))
    formBody = formBody & "&sections_b64url=" & MrpApi_UrlEncode(MrpApi_Base64UrlEncodeUtf8(MrpApi_JsonExtractArray(jsonBody, "bolumler")))
    If Len(Trim$(wbSectionsPayloadB64url)) > 0 Then
        formBody = formBody & "&wb=" & MrpApi_UrlEncode(wbSectionsPayloadB64url)
    End If

    MrpApi_TeklifWorkbookImportForm = MrpApi_RequestForm("POST", "api/teklif/workbook_import", formBody, wbSectionsPayloadB64url)
End Function

Private Function MrpApi_TeklifWorkbookImportFormRaw(ByVal subjectText As String, ByVal companyText As String, ByVal contactText As String, ByVal phoneText As String, ByVal emailText As String, ByVal sectionsJson As String, Optional ByVal wbSectionsPayloadB64url As String = vbNullString) As String
    Dim formBody As String
    Dim safeSections As String

    safeSections = sectionsJson
    If Len(Trim$(safeSections)) = 0 Then safeSections = "[]"

    formBody = ""
    formBody = formBody & "subject=" & MrpApi_UrlEncode(subjectText)
    formBody = formBody & "&company=" & MrpApi_UrlEncode(companyText)
    formBody = formBody & "&contact=" & MrpApi_UrlEncode(contactText)
    formBody = formBody & "&phone=" & MrpApi_UrlEncode(phoneText)
    formBody = formBody & "&email=" & MrpApi_UrlEncode(emailText)
    formBody = formBody & "&bolumler_json=" & MrpApi_UrlEncode(safeSections)
    formBody = formBody & "&bolumler_b64url=" & MrpApi_UrlEncode(MrpApi_Base64UrlEncodeUtf8(safeSections))
    formBody = formBody & "&import_sections_json=" & MrpApi_UrlEncode(safeSections)
    formBody = formBody & "&sections_json=" & MrpApi_UrlEncode(safeSections)
    formBody = formBody & "&sections_b64=" & MrpApi_UrlEncode(MrpApi_Base64EncodeUtf8(safeSections))
    formBody = formBody & "&sections_b64url=" & MrpApi_UrlEncode(MrpApi_Base64UrlEncodeUtf8(safeSections))
    If Len(Trim$(wbSectionsPayloadB64url)) > 0 Then
        formBody = formBody & "&wb=" & MrpApi_UrlEncode(wbSectionsPayloadB64url)
    End If

    MrpApi_TeklifWorkbookImportFormRaw = MrpApi_RequestForm("POST", "api/teklif/workbook_import", formBody, wbSectionsPayloadB64url)
End Function

Private Function MrpApi_Base64UrlEncodeUtf8(ByVal s As String) As String
    Dim b64 As String
    b64 = MrpApi_Base64EncodeUtf8(s)
    b64 = Replace(b64, "+", "-")
    b64 = Replace(b64, "/", "_")
    Do While Right$(b64, 1) = "="
        b64 = Left$(b64, Len(b64) - 1)
    Loop
    MrpApi_Base64UrlEncodeUtf8 = b64
End Function

Private Function MrpApi_Base64EncodeUtf8(ByVal s As String) As String
    Dim stm As Object
    Dim dom As Object
    Dim el As Object

    On Error GoTo Fail

    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 2
    stm.Charset = "utf-8"
    stm.Open
    stm.WriteText s
    stm.Position = 0
    stm.Type = 1

    Set dom = CreateObject("MSXML2.DOMDocument.6.0")
    Set el = dom.createElement("b64")
    el.DataType = "bin.base64"
    el.nodeTypedValue = stm.Read

    MrpApi_Base64EncodeUtf8 = Replace(el.Text, vbCr, "")
    MrpApi_Base64EncodeUtf8 = Replace(MrpApi_Base64EncodeUtf8, vbLf, "")

    stm.Close
    Set el = Nothing
    Set dom = Nothing
    Set stm = Nothing
    Exit Function

Fail:
    MrpApi_Base64EncodeUtf8 = ""
    On Error Resume Next
    If Not stm Is Nothing Then stm.Close
    Set el = Nothing
    Set dom = Nothing
    Set stm = Nothing
End Function

Private Function MrpApi_FileToBase64Url(ByVal filePath As String) As String
    Dim stm As Object
    Dim dom As Object
    Dim el As Object
    Dim b64 As String
    Dim targetPath As String
    Dim tmpPath As String
    Dim ext As String
    Dim wb As Object
    Dim usedTempCopy As Boolean

    On Error GoTo Fail
    If Len(Trim$(filePath)) = 0 Then Exit Function

    targetPath = filePath
    usedTempCopy = False

    ' Acik workbook dogrudan okunamiyorsa temp kopya uzerinden oku.
    On Error Resume Next
    Set wb = Application.ActiveWorkbook
    On Error GoTo Fail
    If Not wb Is Nothing Then
        If LCase$(Trim$(CStr(wb.fullName))) = LCase$(Trim$(filePath)) Then
            ext = Mid$(filePath, InStrRev(filePath, "."))
            If Len(ext) = 0 Then ext = ".xlsm"
            tmpPath = Environ$("TEMP") & "\mrp_upload_" & Format$(Now, "yyyymmdd_hhnnss") & "_" & CStr(Int(Timer * 1000)) & ext
            wb.SaveCopyAs tmpPath
            targetPath = tmpPath
            usedTempCopy = True
        End If
    End If

    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 1
    stm.Open
    stm.LoadFromFile targetPath

    Set dom = CreateObject("MSXML2.DOMDocument.6.0")
    Set el = dom.createElement("b64")
    el.DataType = "bin.base64"
    el.nodeTypedValue = stm.Read
    b64 = Replace(el.Text, vbCr, "")
    b64 = Replace(b64, vbLf, "")
    b64 = Replace(b64, "+", "-")
    b64 = Replace(b64, "/", "_")
    Do While Len(b64) > 0 And Right$(b64, 1) = "="
        b64 = Left$(b64, Len(b64) - 1)
    Loop
    MrpApi_FileToBase64Url = b64

    stm.Close
    Set el = Nothing
    Set dom = Nothing
    Set stm = Nothing
    If usedTempCopy Then
        On Error Resume Next
        Kill tmpPath
        On Error GoTo 0
    End If
    Exit Function

Fail:
    MrpApi_FileToBase64Url = ""
    On Error Resume Next
    If Not stm Is Nothing Then stm.Close
    If usedTempCopy Then Kill tmpPath
    Set el = Nothing
    Set dom = Nothing
    Set stm = Nothing
End Function

Private Function MrpApi_JsonExtractArray(ByVal json As String, ByVal key As String) As String
    Dim pat As String
    Dim p As Long, i As Long
    Dim ch As String
    Dim depth As Long
    Dim inString As Boolean
    Dim prev As String
    Dim startPos As Long

    MrpApi_JsonExtractArray = "[]"
    pat = """" & key & """:"
    p = InStr(1, json, pat, vbTextCompare)
    If p = 0 Then Exit Function
    p = p + Len(pat)

    Do While p <= Len(json)
        ch = Mid$(json, p, 1)
        If ch <> " " And ch <> vbTab And ch <> vbCr And ch <> vbLf Then Exit Do
        p = p + 1
    Loop
    If p > Len(json) Then Exit Function
    If Mid$(json, p, 1) <> "[" Then Exit Function

    startPos = p
    depth = 0
    inString = False
    prev = ""
    For i = p To Len(json)
        ch = Mid$(json, i, 1)
        If ch = """" And prev <> "\" Then
            inString = Not inString
        ElseIf Not inString Then
            If ch = "[" Then depth = depth + 1
            If ch = "]" Then
                depth = depth - 1
                If depth = 0 Then
                    MrpApi_JsonExtractArray = Mid$(json, startPos, i - startPos + 1)
                    Exit Function
                End If
            End If
        End If
        prev = ch
    Next i
End Function

Public Function MrpApi_TeklifUpdate(ByVal teklifId As Long, ByVal jsonBody As String) As String
    MrpApi_TeklifUpdate = MrpApi_Request("PUT", "api/teklif/" & CStr(teklifId), jsonBody)
End Function

' --- Arama uçları (isteğe bağlı) ---

Public Function MrpApi_TeklifSearch(ByVal keyword As String) As String
    MrpApi_TeklifSearch = MrpApi_Request("GET", "api/teklif/search/" & MrpApi_UrlEncode(keyword), vbNullString)
End Function

' Son teklif id + formatlı numara (GET api/teklif/last_number)
' JSON: status, proposal_prefix, last_proposal_id, last_proposal_number
Public Function MrpApi_TeklifLastNumber() As String
    MrpApi_TeklifLastNumber = MrpApi_Request("GET", "api/teklif/last_number", vbNullString)
End Function

' Son teklif/last_number yanıtındaki proposal_prefix + bugünün tarihi (ddmmyy) + "-" + (last_proposal_id + 1).
' Önce mutlaka MrpApi_Configure baseUrl, jwt — veya bu fonksiyona aynı oturumda baseUrl + jwt iletin (ör. MsgBox testi).
' Başarısız istek veya status false ise boş dize (MrpApi_LastHttpStatus / LastResponseBody ile kontrol).
Public Function MrpApi_TeklifNextNumberDdMmYy(Optional ByVal baseUrl As String = "", Optional ByVal jwtToken As String = "") As String
    Dim savedUrl As String
    Dim savedTok As String
    Dim savedAuth As String
    Dim useInline As Boolean
    Dim js As String
    Dim prefix As String
    Dim lastId As Long
    Dim result As String

    savedUrl = m_BaseUrl
    savedTok = m_ApiToken
    savedAuth = m_AuthHeaderName
    useInline = (Len(Trim$(baseUrl)) > 0 And Len(Trim$(jwtToken)) > 0)
    If useInline Then
        MrpApi_Configure baseUrl, jwtToken
    End If

    result = vbNullString
    js = MrpApi_TeklifLastNumber()
    If MrpApi_LastHttpStatus() <> 200 Then GoTo Cleanup
    If Not MrpApi_JsonParseBool(js, "status") Then GoTo Cleanup

    prefix = MrpApi_JsonParseString(js, "proposal_prefix")
    lastId = MrpApi_JsonParseLong(js, "last_proposal_id")
    If Len(prefix) = 0 And lastId > 0 Then
        prefix = MrpApi_ParseProposalPrefixFromFormatted(MrpApi_JsonParseString(js, "last_proposal_number"), lastId)
    End If
    result = prefix & Format(Date, "ddmmyy") & "-" & CStr(lastId + 1)

Cleanup:
    If useInline Then
        m_BaseUrl = savedUrl
        m_ApiToken = savedTok
        m_AuthHeaderName = savedAuth
    End If
    MrpApi_TeklifNextNumberDdMmYy = result
End Function

' Şirket bilgileri — fatura ayarlarındaki firma alanları (GET api/teklif/company)
Public Function MrpApi_CompanyInfo() As String
    MrpApi_CompanyInfo = MrpApi_Request("GET", "api/teklif/company", vbNullString)
End Function

' Tüm aktif şirketler + aktif contact listesi (GET api/teklif/companiescontacts)
' JSON: status, total_companies, total_contacts, companies[] { ..., contacts[] }
Public Function MrpApi_TeklifCompaniesContacts() As String
    Dim primary As String
    Dim customersJs As String
    Dim contactsByCustomer As String
    Dim ids() As Long
    Dim idCount As Long
    Dim i As Long
    Dim oneContacts As String
    Dim code1 As Long
    Dim body1 As String

    ' 1) Öncelik: özel endpoint
    primary = MrpApi_Request("GET", "api/teklif/companiescontacts", vbNullString)
    code1 = MrpApi_LastHttpStatus()
    body1 = MrpApi_LastResponseBody()

    If code1 = 200 Then
        MrpApi_TeklifCompaniesContacts = primary
        Exit Function
    End If

    ' 2) Fallback: custom endpoint canlıda yoksa standart listeleri birleştir
    If (code1 = 405 And InStr(1, body1, "Unknown method", vbTextCompare) > 0) Or code1 = 404 Then
        customersJs = MrpApi_Request("GET", "api/customers", vbNullString)
        If MrpApi_LastHttpStatus() <> 200 Then
            MrpApi_TeklifCompaniesContacts = customersJs
            Exit Function
        End If

        idCount = 0
        Erase ids
        MrpApi_JsonCollectLongValues customersJs, "userid", ids, idCount

        contactsByCustomer = "{"
        For i = 1 To idCount
            oneContacts = MrpApi_Request("GET", "api/contacts/" & CStr(ids(i)), vbNullString)
            If MrpApi_LastHttpStatus() <> 200 Then oneContacts = "[]"
            If i > 1 Then contactsByCustomer = contactsByCustomer & ","
            contactsByCustomer = contactsByCustomer & """" & CStr(ids(i)) & """:" & oneContacts
        Next i
        contactsByCustomer = contactsByCustomer & "}"

        If idCount = 0 Then
            contactsByCustomer = "{}"
        End If

        m_LastHttpStatus = 200
        m_LastResponseBody = "{""status"":true,""source"":""fallback_customers_contacts_by_customer"",""companies"":" & customersJs & ",""contacts_by_customer"":" & contactsByCustomer & "}"
        MrpApi_TeklifCompaniesContacts = m_LastResponseBody
        Exit Function
    End If

    MrpApi_TeklifCompaniesContacts = primary
End Function

' Alias: _get bekleyen kullanımlar için aynı endpoint.
Public Function MrpApi_TeklifCompaniesContacts_Get() As String
    MrpApi_TeklifCompaniesContacts_Get = MrpApi_TeklifCompaniesContacts()
End Function

' Alias: "firma bilgileri/listesi" adıyla çağırmak isteyen modüller için.
Public Function MrpApi_TeklifFirmalarVeContactlar() As String
    MrpApi_TeklifFirmalarVeContactlar = MrpApi_TeklifCompaniesContacts()
End Function

' Müşteri (firma): aynı unvan/vkn › mevcut userid; farklı e-posta+isim › o firmaya yeni kişi (contact_id); yoksa yeni müşteri (POST api/teklif/firma_upsert)
Public Function MrpApi_TeklifFirmaUpsert(ByVal jsonBody As String) As String
    MrpApi_TeklifFirmaUpsert = MrpApi_Request("POST", "api/teklif/firma_upsert", jsonBody)
End Function

'================================================================================
' Dahili: HTTP isteği (MSXML2.ServerXMLHTTP.6.0)
'================================================================================

Private Function MrpApi_Request(ByVal method As String, ByVal path As String, ByVal body As String, Optional ByVal wbHdrB64url As String = vbNullString) As String
    MrpApi_Request = MrpApi_RequestEx(method, path, body, 60000, 60000, wbHdrB64url)
End Function

Private Function MrpApi_RequestForm(ByVal method As String, ByVal path As String, ByVal formBody As String, Optional ByVal wbHdrB64url As String = vbNullString) As String
    Dim url As String
    Dim http As Object

    m_LastHttpStatus = 0
    m_LastResponseBody = vbNullString
    MrpApi_RequestForm = vbNullString

    If Len(m_BaseUrl) = 0 Or Len(m_ApiToken) = 0 Then
        m_LastResponseBody = "{""status"":false,""message"":""MrpApi_Configure ile baseUrl ve JWT (apiToken) ayarlayin""}"
        Exit Function
    End If

    If Len(m_AuthHeaderName) = 0 Then m_AuthHeaderName = "authtoken"
    url = MrpApi_BuildUrl(m_BaseUrl, path)
    m_LastRequestUrl = url

    On Error GoTo HttpErr
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 60000, 60000, 60000, 60000
    http.Open method, url, False
    http.setRequestHeader m_AuthHeaderName, m_ApiToken
    http.setRequestHeader "Accept", "application/json"
    If Len(Trim$(wbHdrB64url)) > 0 Then http.setRequestHeader "X-Mrp-Wb-B64", wbHdrB64url
    http.setRequestHeader "Content-Type", "application/x-www-form-urlencoded; charset=utf-8"
    http.send formBody

    m_LastHttpStatus = http.Status
    m_LastResponseBody = http.responseText
    MrpApi_RequestForm = m_LastResponseBody
    Set http = Nothing
    Exit Function

HttpErr:
    m_LastResponseBody = "{""status"":false,""message"":""" & Replace(Err.Description, """", "'") & """}"
    Set http = Nothing
End Function

' Toplu import: daha uzun gönderme/alma süresi (ms)
Private Function MrpApi_RequestBulk(ByVal method As String, ByVal path As String, ByVal body As String) As String
    MrpApi_RequestBulk = MrpApi_RequestEx(method, path, body, 120000, 300000)
End Function

Private Function MrpApi_RequestEx(ByVal method As String, ByVal path As String, ByVal body As String, ByVal resolveMs As Long, ByVal receiveMs As Long, Optional ByVal wbHdrB64url As String = vbNullString) As String
    Dim url As String
    Dim http As Object
    Dim sendBody As Variant

    m_LastHttpStatus = 0
    m_LastResponseBody = vbNullString
    MrpApi_RequestEx = vbNullString

    If Len(m_BaseUrl) = 0 Or Len(m_ApiToken) = 0 Then
        m_LastResponseBody = "{""status"":false,""message"":""MrpApi_Configure ile baseUrl ve JWT (apiToken) ayarlayin""}"
        Exit Function
    End If

    If Len(m_AuthHeaderName) = 0 Then m_AuthHeaderName = "authtoken"

    url = MrpApi_BuildUrl(m_BaseUrl, path)
    m_LastRequestUrl = url

    On Error GoTo HttpErr

    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    On Error Resume Next
    http.setTimeouts resolveMs, resolveMs, resolveMs, receiveMs
    On Error GoTo HttpErr
    http.Open method, url, False
    http.setRequestHeader m_AuthHeaderName, m_ApiToken
    http.setRequestHeader "Accept", "application/json"
    If Len(Trim$(wbHdrB64url)) > 0 Then http.setRequestHeader "X-Mrp-Wb-B64", wbHdrB64url

    If UCase$(method) = "POST" Or UCase$(method) = "PUT" Then
        http.setRequestHeader "Content-Type", "application/json; charset=utf-8"
        If Len(body) = 0 Then
            http.send
        Else
            sendBody = MrpApi_Utf8Bytes(body)
            http.send sendBody
        End If
    Else
        http.send
    End If

    m_LastHttpStatus = http.Status
    m_LastResponseBody = http.responseText
    MrpApi_RequestEx = m_LastResponseBody
    Set http = Nothing
    Exit Function

HttpErr:
    m_LastResponseBody = "{""status"":false,""message"":""" & Replace(Err.Description, """", "'") & """}"
    Set http = Nothing
End Function

Private Function MrpApi_BuildUrl(ByVal baseUrl As String, ByVal path As String) As String
    Dim b As String
    Dim p As String

    b = RTrim$(Trim$(baseUrl))
    p = LTrim$(Trim$(path))

    If Right$(b, 1) = "/" Then b = Left$(b, Len(b) - 1)
    If Left$(p, 1) = "/" Then p = Mid$(p, 2)

    ' base ".../api" + path "api/..." => "api/api" tekrarını kır.
    If LCase$(Right$(b, 4)) = "/api" And LCase$(Left$(p, 4)) = "api/" Then
        p = Mid$(p, 5)
    End If

    ' base ".../index.php" + path "index.php/..." => index.php tekrarını kır.
    If LCase$(Right$(b, 10)) = "/index.php" And LCase$(Left$(p, 10)) = "index.php/" Then
        p = Mid$(p, 11)
    End If

    MrpApi_BuildUrl = b & "/" & p
End Function

' Türkçe JSON için gövdeyi UTF-8 bayt dizisi olarak gönderir (PUT/POST).
Private Function MrpApi_Utf8Bytes(ByVal s As String) As Variant
    Dim stm As Object
    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 2
    stm.Charset = "utf-8"
    stm.Open
    stm.WriteText s
    stm.Position = 0
    stm.Type = 1
    MrpApi_Utf8Bytes = stm.Read
    stm.Close
    Set stm = Nothing
End Function

' Basit arama parametresi kodlama (boşluk ve özel karakterler)
Private Function MrpApi_UrlEncode(ByVal s As String) As String
    Dim i As Long
    Dim c As String
    Dim b As Long
    Dim Out As String
    Out = ""
    For i = 1 To Len(s)
        c = Mid$(s, i, 1)
        b = AscW(c) And &HFFFF&
        If (b >= 48 And b <= 57) Or (b >= 65 And b <= 90) Or (b >= 97 And b <= 122) Or c = "-" Or c = "_" Or c = "." Or c = "~" Then
            Out = Out & c
        ElseIf c = " " Then
            Out = Out & "%20"
        ElseIf b < 128 Then
            Out = Out & "%" & Right$("0" & Hex(b), 2)
        Else
            Out = Out & "%u" & Right$("0000" & Hex(b), 4)
        End If
    Next i
    MrpApi_UrlEncode = Out
End Function

Private Function MrpApi_TeklifCreateLegacyForm(ByVal subjectText As String, ByVal relId As Long, ByVal proposalTo As String, ByVal emailText As String, ByVal phoneText As String, ByVal totalVal As Double, ByVal itemNames As Collection, ByVal itemRates As Collection) As String
    Dim em As String
    Dim formBody As String
    Dim totalDec As String
    Dim i As Long
    Dim itemDec As String

    em = Trim$(emailText)
    If Len(em) = 0 Then em = "no-reply@local.invalid"
    If totalVal <= 0 Then totalVal = 1
    totalDec = Replace(Format$(totalVal, "0.00"), ",", ".")

    formBody = ""
    formBody = formBody & "subject=" & MrpApi_UrlEncode(subjectText)
    formBody = formBody & "&rel_type=customer"
    formBody = formBody & "&rel_id=" & CStr(relId)
    formBody = formBody & "&proposal_to=" & MrpApi_UrlEncode(proposalTo)
    formBody = formBody & "&email=" & MrpApi_UrlEncode(em)
    formBody = formBody & "&phone=" & MrpApi_UrlEncode(phoneText)
    formBody = formBody & "&date=" & MrpApi_UrlEncode(Format(Date, "yyyy-mm-dd"))
    formBody = formBody & "&currency=1"
    formBody = formBody & "&status=6"
    formBody = formBody & "&subtotal=" & MrpApi_UrlEncode(totalDec)
    formBody = formBody & "&total=" & MrpApi_UrlEncode(totalDec)
    If itemNames Is Nothing Or itemRates Is Nothing Or itemNames.Count = 0 Or itemRates.Count = 0 Then
        formBody = formBody & "&newitems[0][description]=" & MrpApi_UrlEncode(subjectText)
        formBody = formBody & "&newitems[0][long_description]="
        formBody = formBody & "&newitems[0][qty]=1"
        formBody = formBody & "&newitems[0][rate]=" & MrpApi_UrlEncode(totalDec)
        formBody = formBody & "&newitems[0][order]=1"
        formBody = formBody & "&newitems[0][unit]="
    Else
        For i = 1 To itemNames.Count
            itemDec = Replace(Format$(MrpApi_ToDouble(itemRates(i)), "0.00"), ",", ".")
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][description]=" & MrpApi_UrlEncode(CStr(itemNames(i)))
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][long_description]="
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][qty]=1"
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][rate]=" & MrpApi_UrlEncode(itemDec)
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][order]=" & CStr(i)
            formBody = formBody & "&newitems[" & CStr(i - 1) & "][unit]="
        Next i
    End If

    MrpApi_TeklifCreateLegacyForm = MrpApi_RequestForm("POST", "api/teklif", formBody)
End Function

' last_number yanıtı için yalın JSON alan okuyucular (Scripting.Dictionary yok).
Private Function MrpApi_JsonParseBool(ByVal json As String, ByVal key As String) As Boolean
    Dim pat As String
    Dim p As Long
    pat = """" & key & """:"
    p = InStr(1, json, pat, vbTextCompare)
    If p = 0 Then Exit Function
    p = p + Len(pat)
    Do While p <= Len(json)
        Select Case Mid$(json, p, 1)
            Case " ", vbTab, vbLf, vbCr
                p = p + 1
            Case Else
                Exit Do
        End Select
    Loop
    If LCase$(Mid$(json, p, 4)) = "true" Then MrpApi_JsonParseBool = True
End Function

Private Function MrpApi_JsonParseLong(ByVal json As String, ByVal key As String) As Long
    Dim pat As String
    Dim p As Long
    Dim i As Long
    Dim ch As String
    Dim v As Long
    pat = """" & key & """:"
    p = InStr(1, json, pat, vbTextCompare)
    If p = 0 Then Exit Function
    p = p + Len(pat)
    Do While p <= Len(json)
        Select Case Mid$(json, p, 1)
            Case " ", vbTab, vbLf, vbCr
                p = p + 1
            Case Else
                Exit Do
        End Select
    Loop
    v = 0
    For i = p To Len(json)
        ch = Mid$(json, i, 1)
        If ch >= "0" And ch <= "9" Then
            v = v * 10 + (Asc(ch) - 48)
        Else
            Exit For
        End If
    Next i
    MrpApi_JsonParseLong = v
End Function

Private Function MrpApi_JsonParseString(ByVal json As String, ByVal key As String) As String
    Dim pat As String
    Dim p As Long
    Dim q As Long
    pat = """" & key & """:"""
    p = InStr(1, json, pat, vbTextCompare)
    If p = 0 Then Exit Function
    p = p + Len(pat)
    q = InStr(p, json, """")
    If q = 0 Or q <= p Then Exit Function
    MrpApi_JsonParseString = Mid$(json, p, q - p)
End Function

' last_proposal_number biçimi: {prefix}{ddmmyy}-{id} (format_proposal_number ile uyumlu)
Private Function MrpApi_ParseProposalPrefixFromFormatted(ByVal formatted As String, ByVal lastId As Long) As String
    Dim sfx As String
    Dim w As String
    Dim dmy As String
    Dim i As Long
    MrpApi_ParseProposalPrefixFromFormatted = vbNullString
    If lastId <= 0 Or Len(formatted) = 0 Then Exit Function
    sfx = "-" & CStr(lastId)
    If Len(formatted) < Len(sfx) + 6 Then Exit Function
    If Right$(formatted, Len(sfx)) <> sfx Then Exit Function
    w = Left$(formatted, Len(formatted) - Len(sfx))
    If Len(w) < 6 Then Exit Function
    dmy = Right$(w, 6)
    For i = 1 To 6
        If Mid$(dmy, i, 1) < "0" Or Mid$(dmy, i, 1) > "9" Then Exit Function
    Next i
    MrpApi_ParseProposalPrefixFromFormatted = Left$(w, Len(w) - 6)
End Function

' JSON içinde tekrarlayan sayısal alanları toplar (örn. userid).
Private Sub MrpApi_JsonCollectLongValues(ByVal json As String, ByVal key As String, ByRef outIds() As Long, ByRef outCount As Long)
    Dim pat As String
    Dim p As Long
    Dim i As Long
    Dim ch As String
    Dim n As Long
    Dim exists As Boolean
    Dim k As Long

    pat = """" & key & """:"
    p = 1
    outCount = 0

    Do
        p = InStr(p, json, pat, vbTextCompare)
        If p = 0 Then Exit Do
        p = p + Len(pat)

        Do While p <= Len(json)
            ch = Mid$(json, p, 1)
            If ch = " " Or ch = vbTab Or ch = vbLf Or ch = vbCr Or ch = """" Then
                p = p + 1
            Else
                Exit Do
            End If
        Loop

        n = 0
        For i = p To Len(json)
            ch = Mid$(json, i, 1)
            If ch >= "0" And ch <= "9" Then
                n = n * 10 + (Asc(ch) - 48)
            Else
                Exit For
            End If
        Next i

        If n > 0 Then
            exists = False
            For k = 1 To outCount
                If outIds(k) = n Then
                    exists = True
                    Exit For
                End If
            Next k
            If Not exists Then
                outCount = outCount + 1
                ReDim Preserve outIds(1 To outCount)
                outIds(outCount) = n
            End If
        End If
    Loop
End Sub

'================================================================================
' ÖRNEK PROSEDÜRLER (dosya sonu)
'   MrpApi_Example_Configure, MrpApi_Example_SetAuthHeader, MrpApi_Example_ShowLastResponse
'   MrpApi_Example_LastHttpStatus, MrpApi_Example_LastResponseBody
'   MrpApi_Example_ProductGet_List / _ById, _ProductCreate, _ProductUpdate
'   MrpApi_Example_BomGet_List / _ById, _BomCreate, _BomUpdate
'   MrpApi_Example_TeklifGet_List / _ById, _TeklifCreate, _TeklifUpdate, _TeklifSearch
'   MrpApi_Example_TeklifLastNumber, MrpApi_Example_TeklifNextNumberDdMmYy, MrpApi_Example_CompanyInfo, MrpApi_Example_TeklifCompaniesContacts, MrpApi_Example_TeklifMeta_Both
'   MrpApi_Example_TeklifFirmaUpsert
' Sabitler modülün üstünde (Option Explicit sonrası). F5 ile çalıştırın.
'================================================================================

' MrpApi_Configure — base URL ve JWT token
Public Sub MrpApi_Example_Configure()
    If MrpApi_ConfigureFromDesktopTeklif() Then
        Debug.Print "MrpApi_Configure: Desktop Teklif settings.json"
        Debug.Print "  path: " & MrpApi_DesktopTeklifSettingsPath()
        Debug.Print "  baseUrl: " & m_BaseUrl
        Debug.Print "  jwt len: " & CStr(Len(m_ApiToken))
    Else
        MsgBox "Desktop Teklif JWT bulunamadi." & vbCrLf & _
               MrpApi_DesktopTeklifSettingsPath() & vbCrLf & vbCrLf & _
               "Once Desktop Teklif > Ayarlar'dan JWT kaydedin.", vbExclamation
    End If
End Sub

' MrpApi_SetAuthHeader — jwt.php token_header farklıysa (varsayılan: authtoken)
Public Sub MrpApi_Example_SetAuthHeader()
    MrpApi_Example_Configure
    MrpApi_SetAuthHeader "authtoken"
    Debug.Print "Auth header: authtoken"
End Sub

' MrpApi_LastHttpStatus — yalnızca son HTTP durum kodu
Public Sub MrpApi_Example_LastHttpStatus()
    Debug.Print MrpApi_LastHttpStatus()
End Sub

' MrpApi_LastResponseBody — yalnızca son yanıt gövdesi
Public Sub MrpApi_Example_LastResponseBody()
    Debug.Print MrpApi_LastResponseBody()
End Sub

' MrpApi_TokenOwnerInfo / MrpApi_TokenOwnerName
Public Sub MrpApi_Example_TokenOwnerName()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TokenOwnerName()
    MrpApi_Example_ShowLastResponse
End Sub

' Son isteğin hem kodu hem gövdesi
Public Sub MrpApi_Example_ShowLastResponse()
    Debug.Print "HTTP "; MrpApi_LastHttpStatus()
    Debug.Print MrpApi_LastResponseBody()
End Sub

' --- Ürün örnekleri ---

' MrpApi_ProductGet — tüm ürünler
Public Sub MrpApi_Example_ProductGet_List()
    MrpApi_Example_Configure
    Debug.Print MrpApi_ProductGet
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_ProductGet — tek ürün (id değiştirin)
Public Sub MrpApi_Example_ProductGet_ById()
    MrpApi_Example_Configure
    Debug.Print MrpApi_ProductGet(1)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_ProductCreate
Public Sub MrpApi_Example_ProductCreate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""description"":""VBA Ornek Urun"",""commodity_code"":""VBA-DEMO-001"",""rate"":0}"
    Debug.Print MrpApi_ProductCreate(js)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_ProductUpdate (id ve alanları güncelleyin)
Public Sub MrpApi_Example_ProductUpdate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""description"":""VBA Guncellendi"",""rate"":10}"
    Debug.Print MrpApi_ProductUpdate(1, js)
    MrpApi_Example_ShowLastResponse
End Sub

' --- BOM örnekleri ---

' MrpApi_BomGet — liste
Public Sub MrpApi_Example_BomGet_List()
    MrpApi_Example_Configure
    Debug.Print MrpApi_BomGet
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_BomGet — tek BOM + satırlar
Public Sub MrpApi_Example_BomGet_ById()
    MrpApi_Example_Configure
    Debug.Print MrpApi_BomGet(1)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_BomCreate (product_id ve lines içindeki product_id'leri gerçek stok id'leriyle değiştirin)
Public Sub MrpApi_Example_BomCreate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""product_id"":1,""lines"":[{""product_id"":2,""product_qty"":1}]}"
    Debug.Print MrpApi_BomCreate(js)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_BomUpdate
Public Sub MrpApi_Example_BomUpdate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""product_qty"":1,""lines"":[{""product_id"":2,""product_qty"":2}]}"
    Debug.Print MrpApi_BomUpdate(1, js)
    MrpApi_Example_ShowLastResponse
End Sub

' --- Teklif örnekleri ---

' MrpApi_TeklifGet — liste
Public Sub MrpApi_Example_TeklifGet_List()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifGet
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifGet — tek kayıt
Public Sub MrpApi_Example_TeklifGet_ById()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifGet(1)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifCreate (rel_id, email, müşteri bilgilerini kendi verinize göre düzenleyin)
Public Sub MrpApi_Example_TeklifCreate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""subject"":""VBA Teklif"",""rel_type"":""customer"",""rel_id"":1," & _
         """proposal_to"":""Ornek Firma"",""email"":""ornek@firma.com"",""date"":""2026-04-03""," & _
         """currency"":""1"",""status"":""6"",""subtotal"":100,""total"":100," & _
         """newitems"":[{""description"":""Satir 1"",""long_description"":"""",""qty"":1,""rate"":100,""order"":1,""unit"":""""}]}"
    Debug.Print MrpApi_TeklifCreate(js)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifUpdate (PUT için items zorunlu; mevcut satırları API'den alıp düzenleyin)
Public Sub MrpApi_Example_TeklifUpdate()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""subject"":""VBA Guncel Teklif"",""rel_type"":""customer"",""rel_id"":1," & _
         """proposal_to"":""Ornek Firma"",""email"":""ornek@firma.com"",""date"":""2026-04-03""," & _
         """currency"":""1"",""status"":6,""subtotal"":100,""total"":100," & _
         """items"":{""1"":{""itemid"":""1"",""order"":1,""description"":""Satir"",""long_description"":"""",""qty"":1,""unit"":"""",""rate"":100}}}"
    Debug.Print MrpApi_TeklifUpdate(1, js)
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifSearch
Public Sub MrpApi_Example_TeklifSearch()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifSearch("test")
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifLastNumber — JSON: status, proposal_prefix, last_proposal_id, last_proposal_number
Public Sub MrpApi_Example_TeklifLastNumber()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifLastNumber()
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifNextNumberDdMmYy — önerilen yeni numara (prefix + ddmmyy + "-" + son_id+1)
Public Sub MrpApi_Example_TeklifNextNumberDdMmYy()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifNextNumberDdMmYy()
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_CompanyInfo — JSON: status, company { company_name, address, city, ... }
Public Sub MrpApi_Example_CompanyInfo()
    MrpApi_Example_Configure
    Debug.Print MrpApi_CompanyInfo()
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifCompaniesContacts — JSON: status, total_companies, total_contacts, companies[]
Public Sub MrpApi_Example_TeklifCompaniesContacts()
    MrpApi_Example_Configure
    Debug.Print MrpApi_TeklifCompaniesContacts()
    MrpApi_Example_ShowLastResponse
End Sub

' Üst üste: son teklif numarası + firma (Immediate penceresinde iki blok)
Public Sub MrpApi_Example_TeklifMeta_Both()
    MrpApi_Example_Configure
    Debug.Print "--- last_number ---"
    Debug.Print MrpApi_TeklifLastNumber()
    Debug.Print "--- company ---"
    Debug.Print MrpApi_CompanyInfo()
    MrpApi_Example_ShowLastResponse
End Sub

' MrpApi_TeklifFirmaUpsert — JSON yanıt: matched/created, userid (teklif rel_id için customer)
' JSON tek satırda ( _ ile birleştirme hatası riski yok).
Public Sub MrpApi_Example_TeklifFirmaUpsert()
    Dim js As String
    MrpApi_Example_Configure
    js = "{""company"":""Ornek Firma A.S."",""vat"":""1234567890"",""phonenumber"":""02120000000"",""address"":""Adres"",""city"":""Istanbul"",""email"":""yetkili@ornek.com"",""contact_firstname"":""Ad"",""contact_lastname"":""Soyad""}"
    Debug.Print Len(js); " "; MrpApi_TeklifFirmaUpsert(js)
    MrpApi_Example_ShowLastResponse
End Sub

' API'den firma + contact verisini "Teklif Firma Bilgileri.xlsb" dosyasina yazar.
' Hedef kolonlar (mevcut form ile uyumlu):
'   A: sira, B: firma, C: adres, D: firma tel, E: fax(bos), F: ilgili, G: email, H: ilgili tel
Public Sub MrpApi_ImportCompaniesContactsToWorkbook( _
    Optional ByVal targetPath As String = "C:\Belgelerim\Cemex\Parametreler\Teklif Firma Bilgileri.xlsb", _
    Optional ByVal sheetName As String = "Sayfa1", _
    Optional ByVal clearOldRows As Boolean = True)

    Dim wb As Object
    Dim ws As Object
    Dim w As Object
    Dim wasOpen As Boolean

    Dim rowsJs As String
    Dim customersJs As String
    Dim contactsJs As String
    Dim firms As Collection
    Dim addresses As Collection
    Dim firmPhones As Collection
    Dim names As Collection
    Dim emails As Collection
    Dim phones As Collection
    Dim firstNames As Collection
    Dim lastNames As Collection

    Dim i As Long
    Dim j As Long
    Dim rowNo As Long
    Dim fullName As String
    Dim ids() As Long
    Dim idCount As Long
    Dim useRowsEndpoint As Boolean
    Dim firstContactFailStatus As Long
    Dim firstContactFailBody As String

    On Error GoTo Fail
    firstContactFailStatus = 0
    firstContactFailBody = vbNullString

    rowsJs = MrpApi_Request("GET", "api/teklif/companiescontacts_rows", vbNullString)
    useRowsEndpoint = (MrpApi_LastHttpStatus() = 200)

    If useRowsEndpoint Then
        Set firms = MrpApi_JsonExtractValues(rowsJs, "company", False)
        Set addresses = MrpApi_JsonExtractValues(rowsJs, "address", False)
        Set firmPhones = MrpApi_JsonExtractValues(rowsJs, "company_phone", False)
        Set names = MrpApi_JsonExtractValues(rowsJs, "contact_name", False)
        Set emails = MrpApi_JsonExtractValues(rowsJs, "email", False)
        Set phones = MrpApi_JsonExtractValues(rowsJs, "contact_phone", False)
    Else
        ' Canlıda yeni endpoint yoksa otomatik klasik yola düş.
        customersJs = MrpApi_Request("GET", "api/customers", vbNullString)
        If MrpApi_LastHttpStatus() <> 200 Then
            MsgBox "Firma listesi alinamadi. HTTP " & CStr(MrpApi_LastHttpStatus()), vbExclamation
            Exit Sub
        End If
        Set firms = MrpApi_JsonExtractValues(customersJs, "company", False)
        Set addresses = MrpApi_JsonExtractValues(customersJs, "address", False)
        Set firmPhones = MrpApi_JsonExtractValues(customersJs, "phonenumber", False)
        idCount = 0
        Erase ids
        MrpApi_JsonCollectLongValues customersJs, "userid", ids, idCount
    End If

    wasOpen = False
    For Each w In Application.Workbooks
        If StrComp(CStr(w.fullName), targetPath, vbTextCompare) = 0 Or StrComp(CStr(w.Name), dir$(targetPath), vbTextCompare) = 0 Then
            Set wb = w
            wasOpen = True
            Exit For
        End If
    Next w
    If wb Is Nothing Then
        Set wb = Application.Workbooks.Open(targetPath)
    End If

    Set ws = wb.Worksheets(sheetName)
    If clearOldRows Then
        ws.Range("A2:V1048576").ClearContents
    End If

    rowNo = 2
    If useRowsEndpoint Then
        For i = 1 To firms.Count
            fullName = MrpApi_ColValue(names, i)
            If Len(fullName) = 0 Then fullName = "Yetkili"
            ws.Cells(rowNo, 1).Value = rowNo - 1
            ws.Cells(rowNo, 2).Value = MrpApi_ColValue(firms, i)
            ws.Cells(rowNo, 3).Value = MrpApi_ColValue(addresses, i)
            ws.Cells(rowNo, 4).Value = MrpApi_ColValue(firmPhones, i)
            ws.Cells(rowNo, 6).Value = fullName
            ws.Cells(rowNo, 7).Value = MrpApi_ColValue(emails, i)
            ws.Cells(rowNo, 8).Value = MrpApi_ColValue(phones, i)
            rowNo = rowNo + 1
        Next i
    Else
        For i = 1 To idCount
            contactsJs = MrpApi_Request("GET", "api/contacts/" & CStr(ids(i)), vbNullString)
            If MrpApi_LastHttpStatus() = 200 Then
                Set firstNames = MrpApi_JsonExtractValues(contactsJs, "firstname", False)
                Set lastNames = MrpApi_JsonExtractValues(contactsJs, "lastname", False)
                Set emails = MrpApi_JsonExtractValues(contactsJs, "email", False)
                Set phones = MrpApi_JsonExtractValues(contactsJs, "phonenumber", False)
                If firstNames.Count = 0 And emails.Count = 0 Then
                    ws.Cells(rowNo, 1).Value = rowNo - 1
                    ws.Cells(rowNo, 2).Value = MrpApi_ColValue(firms, i)
                    ws.Cells(rowNo, 3).Value = MrpApi_ColValue(addresses, i)
                    ws.Cells(rowNo, 4).Value = MrpApi_ColValue(firmPhones, i)
                    ws.Cells(rowNo, 6).Value = "Yetkili"
                    rowNo = rowNo + 1
                Else
                    For j = 1 To IIf(firstNames.Count > emails.Count, firstNames.Count, emails.Count)
                        fullName = Trim$(MrpApi_ColValue(firstNames, j) & " " & MrpApi_ColValue(lastNames, j))
                        If Len(fullName) = 0 Then fullName = MrpApi_ColValue(emails, j)
                        If Len(fullName) = 0 Then fullName = "Yetkili"
                        ws.Cells(rowNo, 1).Value = rowNo - 1
                        ws.Cells(rowNo, 2).Value = MrpApi_ColValue(firms, i)
                        ws.Cells(rowNo, 3).Value = MrpApi_ColValue(addresses, i)
                        ws.Cells(rowNo, 4).Value = MrpApi_ColValue(firmPhones, i)
                        ws.Cells(rowNo, 6).Value = fullName
                        ws.Cells(rowNo, 7).Value = MrpApi_ColValue(emails, j)
                        ws.Cells(rowNo, 8).Value = MrpApi_ColValue(phones, j)
                        rowNo = rowNo + 1
                    Next j
                End If
            Else
                ' 404 "No data were found" = bu firmada contact kaydi yok; teknik hata degil.
                If firstContactFailStatus = 0 And MrpApi_LastHttpStatus() <> 404 Then
                    firstContactFailStatus = MrpApi_LastHttpStatus()
                    firstContactFailBody = MrpApi_LastResponseBody()
                End If
                ws.Cells(rowNo, 1).Value = rowNo - 1
                ws.Cells(rowNo, 2).Value = MrpApi_ColValue(firms, i)
                ws.Cells(rowNo, 3).Value = MrpApi_ColValue(addresses, i)
                ws.Cells(rowNo, 4).Value = MrpApi_ColValue(firmPhones, i)
                ws.Cells(rowNo, 6).Value = "Yetkili"
                rowNo = rowNo + 1
            End If
        Next i
    End If

    wb.Save
    If Not wasOpen Then wb.Close False

    If firstContactFailStatus <> 0 Then
        MsgBox "Aktarim tamamlandi; ancak contact endpoint yanit vermedi." & vbCrLf & _
               "HTTP: " & CStr(firstContactFailStatus) & vbCrLf & _
               Left$(firstContactFailBody, 300), vbExclamation
        Exit Sub
    End If

    Debug.Print "Aktarim tamamlandi. Kayit: " & CStr(rowNo - 2), vbInformation
    Exit Sub

Fail:
    Debug.Print "Aktarim hatasi: " & Err.Description, vbCritical
End Sub

Public Sub MrpApi_Example_ImportCompaniesContactsToWorkbook()
    MrpApi_Example_Configure
    MrpApi_ImportCompaniesContactsToWorkbook
End Sub

Private Function MrpApi_JsonExtractValues(ByVal json As String, ByVal key As String, ByVal numericValue As Boolean) As Collection
    Dim re As Object
    Dim ms As Object
    Dim m As Object
    Dim Out As New Collection
    Dim pat As String

    Set re = CreateObject("VBScript.RegExp")
    re.Global = True
    re.Multiline = True
    re.IgnoreCase = True

    If numericValue Then
        pat = """" & key & """" & "\s*:\s*""?(\d+)""?"
    Else
        pat = """" & key & """" & "\s*:\s*""((?:\\.|[^""])*)"""
    End If
    re.Pattern = pat

    Set ms = re.Execute(json)
    For Each m In ms
        Out.Add MrpApi_JsonUnescape(CStr(m.SubMatches(0)))
    Next m

    Set MrpApi_JsonExtractValues = Out
End Function

Private Function MrpApi_JsonUnescape(ByVal s As String) As String
    Dim t As String
    t = s
    t = Replace(t, "\" & Chr$(34), Chr$(34))
    t = Replace(t, "\\", "\")
    t = Replace(t, "\/", "/")
    t = Replace(t, "\r", vbCr)
    t = Replace(t, "\n", vbLf)
    t = Replace(t, "\t", vbTab)
    t = MrpApi_DecodeUnicodeEscapes(t)
    MrpApi_JsonUnescape = t
End Function

Private Function MrpApi_DecodeUnicodeEscapes(ByVal s As String) As String
    Dim i As Long
    Dim Out As String
    Dim hx As String

    i = 1
    Out = ""
    Do While i <= Len(s)
        If i + 5 <= Len(s) And Mid$(s, i, 2) = "\u" Then
            hx = Mid$(s, i + 2, 4)
            If hx Like "[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]" Then
                Out = Out & ChrW$(CLng("&H" & hx))
                i = i + 6
            Else
                Out = Out & Mid$(s, i, 1)
                i = i + 1
            End If
        Else
            Out = Out & Mid$(s, i, 1)
            i = i + 1
        End If
    Loop
    MrpApi_DecodeUnicodeEscapes = Out
End Function

Private Function MrpApi_ColValue(ByVal col As Collection, ByVal idx As Long) As String
    On Error GoTo Out
    If idx >= 1 And idx <= col.Count Then
        MrpApi_ColValue = CStr(col(idx))
        Exit Function
    End If
Out:
    MrpApi_ColValue = vbNullString
End Function

Public Sub MrpApi_SendWorkbookForServerBuild()
    Dim reqJson As String
    Dim resp As String
    Dim fileB64 As String
    Dim workbookName As String

    On Error GoTo Fail

    MrpApi_Example_Configure
    If Not MrpApi_IsConfigured() Then
        MsgBox "API ayari yok. Once MrpApi_Configure ""https://..."" ,""JWT..."" cagrin.", vbExclamation
        Exit Sub
    End If

    workbookName = ActiveWorkbook.Name
    fileB64 = MrpApi_FileToBase64Url(ActiveWorkbook.fullName)
    If Len(fileB64) = 0 Then
        MsgBox "Calisan dosya okunamadi veya base64'e cevrilemedi.", vbExclamation
        Exit Sub
    End If

    reqJson = "{""workbook_name"":""" & MrpApi_JsonEscape(workbookName) & """," & _
              """workbook_b64url"":""" & fileB64 & """}"

    resp = MrpApi_TeklifWorkbookSubmit(reqJson)
    If MrpApi_LastHttpStatus() <> 200 Or Not MrpApi_JsonParseBool(resp, "status") Then
        MsgBox "Teklif olusturma basarisiz. HTTP " & CStr(MrpApi_LastHttpStatus()) & vbCrLf & _
               "Son URL: " & MrpApi_LastRequestUrl() & vbCrLf & Left$(resp, 450), vbExclamation
        Exit Sub
    End If

    Debug.Print "Tamamlandi." & vbCrLf & _
           "- Teklif ID: " & CStr(MrpApi_JsonParseLong(resp, "proposal_id")) & vbCrLf & _
           "- Musteri ID: " & CStr(MrpApi_JsonParseLong(resp, "client_id")), vbInformation
    Exit Sub

Fail:
    Debug.Print "Hata: " & Err.Description, vbCritical
End Sub

Private Function MrpApi_JsonEscape(ByVal s As String) As String
    Dim t As String
    t = s
    t = Replace(t, "\", "\\")
    t = Replace(t, """", "\""")
    t = Replace(t, vbCrLf, "\n")
    t = Replace(t, vbCr, "\n")
    t = Replace(t, vbLf, "\n")
    MrpApi_JsonEscape = t
End Function

Private Function MrpApi_ToDouble(ByVal v As Variant) As Double
    Dim s As String
    Dim i As Long
    Dim ch As String
    Dim cleaned As String
    s = Trim$(CStr(v))
    If Len(s) = 0 Then
        MrpApi_ToDouble = 0
        Exit Function
    End If

    ' Para/birim metinlerini ayikla: "9,67 $", "1 Adet", vb.
    cleaned = ""
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        If (ch >= "0" And ch <= "9") Or ch = "," Or ch = "." Or ch = "-" Then
            cleaned = cleaned & ch
        End If
    Next i

    If InStr(cleaned, ",") > 0 And InStr(cleaned, ".") > 0 Then
        cleaned = Replace(cleaned, ".", "")
    End If
    cleaned = Replace(cleaned, ",", ".")

    If cleaned = "" Or cleaned = "-" Then
        MrpApi_ToDouble = 0
    ElseIf IsNumeric(cleaned) Then
        MrpApi_ToDouble = CDbl(cleaned)
    Else
        MrpApi_ToDouble = 0
    End If
End Function
