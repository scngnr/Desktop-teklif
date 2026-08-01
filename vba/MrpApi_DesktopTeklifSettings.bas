Attribute VB_Name = "MrpApiDesktopSettings"
Option Explicit

'================================================================================
' Desktop Teklif Ayarlari -> MrpApi
' JWT / baseUrl: %APPDATA%\desktop-teklif\settings.json
'
' Kullanim (MrpApi modulunde):
'   MrpApi_Example_Configure  yerine veya icinde:
'     If Not MrpApiDesktopSettings_Configure() Then ...
'================================================================================

Private Const FALLBACK_BASE_URL As String = "https://mrp.cangungor.tr"

Public Function MrpApiDesktopSettings_Path() As String
    MrpApiDesktopSettings_Path = Environ$("APPDATA") & "\desktop-teklif\settings.json"
End Function

Public Function MrpApiDesktopSettings_ReadFile() As String
    Dim p As String
    Dim f As Integer
    Dim txt As String

    MrpApiDesktopSettings_ReadFile = vbNullString
    p = MrpApiDesktopSettings_Path()
    If Len(Dir$(p)) = 0 Then Exit Function

    On Error GoTo Fail
    f = FreeFile
    Open p For Binary Access Read As #f
    If LOF(f) > 0 Then
        txt = String$(LOF(f), vbNullChar)
        Get #f, , txt
    End If
    Close #f

    ' UTF-8 BOM temizle
    If Left$(txt, 3) = Chr$(239) & Chr$(187) & Chr$(191) Then
        txt = Mid$(txt, 4)
    End If
    MrpApiDesktopSettings_ReadFile = txt
    Exit Function
Fail:
    On Error Resume Next
    Close #f
    MrpApiDesktopSettings_ReadFile = vbNullString
End Function

' "key": "value"  — arada bosluk olabilir
Public Function MrpApiDesktopSettings_JsonString(ByVal json As String, ByVal key As String) As String
    Dim pat As String
    Dim p As Long
    Dim q As Long
    Dim ch As String

    MrpApiDesktopSettings_JsonString = vbNullString
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
    MrpApiDesktopSettings_JsonString = Mid$(json, p, q - p)
End Function

Public Function MrpApiDesktopSettings_Jwt() As String
    Dim js As String
    js = MrpApiDesktopSettings_ReadFile()
    If Len(js) = 0 Then Exit Function
    MrpApiDesktopSettings_Jwt = Trim$(MrpApiDesktopSettings_JsonString(js, "authToken"))
End Function

Public Function MrpApiDesktopSettings_BaseUrl() As String
    Dim js As String
    Dim u As String
    js = MrpApiDesktopSettings_ReadFile()
    If Len(js) = 0 Then
        MrpApiDesktopSettings_BaseUrl = FALLBACK_BASE_URL
        Exit Function
    End If
    u = Trim$(MrpApiDesktopSettings_JsonString(js, "baseUrl"))
    If Len(u) = 0 Then u = FALLBACK_BASE_URL
    If InStr(1, LCase$(u), "://rmp.cangungor.tr", vbTextCompare) > 0 Then
        u = Replace(u, "://rmp.cangungor.tr", "://mrp.cangungor.tr", 1, -1, vbTextCompare)
    End If
    Do While Right$(u, 1) = "/"
        u = Left$(u, Len(u) - 1)
    Loop
    MrpApiDesktopSettings_BaseUrl = u
End Function

' MrpApi_Configure cagirir. JWT yoksa False.
Public Function MrpApiDesktopSettings_Configure() As Boolean
    Dim jwt As String
    Dim url As String

    jwt = MrpApiDesktopSettings_Jwt()
    url = MrpApiDesktopSettings_BaseUrl()

    If Len(jwt) = 0 Then
        MrpApiDesktopSettings_Configure = False
        Exit Function
    End If

    MrpApi_Configure url, jwt
    MrpApiDesktopSettings_Configure = True
End Function
