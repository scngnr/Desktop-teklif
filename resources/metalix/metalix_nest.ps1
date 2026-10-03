<#
.SYNOPSIS
  Perfex ORD -> cncKad .dft -> AutoNest yerlesim -> Order Report CSV (Metalix V16, tamamen basliksiz/COM).

.DESCRIPTION
  1) cncKad (gkadw) acik pencereli ise DURUR (kullanicinin penceresine dokunmaz). Penceresiz gkadw (zombi) sadece uyari.
  2) ORD'deki her DXF: cncKadPart.Document -> SetCurMachine, ImportFile2, AutoCut3, InterfaceSave (.dft DXF'in yanina).
  3) <ord>_dft.ORD yazar (DXF yollari .dft ile degisir).
  4) AutoNest.Document: SetCurMachine, LoadOrdFile2, SheetSizes*API*, DoStartAutoNest3(1), Save(.dsp), DoOrderReport(Template, OutCsv).
  5) Basarida son satir:  CSV <OutCsv>   (cikis kodu 0). Yerlesmeyen parca varsa ondan once 'UYARI yerlesmeyen parca: N' satiri yazilir (cikis kodu yine 0). Hatada "HATA ..." ve sifirdan farkli cikis kodu.

  Cikis kodlari: 0 tamam | 2 girdi/dosya | 3 cncKad/AutoNest penceresi acik | 4 rapor sablonu yok
                 5 DXF/AutoCut hatasi | 6 yerlesim/.dsp hatasi | 7 CSV gecersiz (kesim suresi 0 / pierce 0 / dosya yok)
                 8 beklenmeyen hata

  Asla: GenerateNC, CreatePicture, lisans/kayit defteri degisikligi, gkadw sonlandirma.
  COM sunuculari 32-bit kayitli: 64-bit PowerShell'den cagrilirsa betik kendini SysWOW64 powershell ile yeniden baslatir.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File metalix_nest.ps1 -OrdFile C:\Metalix\Perfex\MO\MO_DKP_1.5.ORD `
     -Template C:\Metalix\RPT_AN_ALL_AUT_ENG_Perfex.csv -OutCsv C:\Metalix\Perfex\MO\nest.csv -SheetX 2500 -SheetY 1250 -SheetQty 200
#>
param(
    [Parameter(Mandatory = $true)][string]$OrdFile,
    [Parameter(Mandatory = $true)][string]$Template,
    [Parameter(Mandatory = $true)][string]$OutCsv,
    [int]$Machine = -1,
    [double]$SheetX = 2500,
    [double]$SheetY = 1250,
    [int]$SheetQty = 200
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

# ---- 32-bit yeniden baslat (AutoNest/cncKad COM sunuculari WOW6432Node'da kayitli) ----
if ([Environment]::Is64BitProcess) {
    $ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $ps32) {
        $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
        foreach ($k in $PSBoundParameters.Keys) { $a += "-$k"; $a += [string]$PSBoundParameters[$k] }
        & $ps32 @a
        exit $LASTEXITCODE
    }
}

$script:step = ''
function Out-Line([string]$m) { Write-Output ((Get-Date -f 'HH:mm:ss') + ' ' + $m) }
function Fail([int]$code, [string]$m) { Write-Output ('HATA ' + $m); exit $code }
function Inv($o, [string]$n, [object[]]$a = @()) { [System.__ComObject].InvokeMember($n, [Reflection.BindingFlags]::InvokeMethod, $null, $o, $a) }
function GetP($o, [string]$n) { [System.__ComObject].InvokeMember($n, [Reflection.BindingFlags]::GetProperty, $null, $o, $null) }
function Root-Msg($e) { while ($e.InnerException) { $e = $e.InnerException }; return $e.Message }
function Read-IniMachine {
    foreach ($f in @((Join-Path $env:WINDIR 'METALIX.INI'))) {
        if (Test-Path -LiteralPath $f) {
            $l = Select-String -LiteralPath $f -Pattern '^\s*CURRENT_MACHINE\s*=\s*(\d+)' | Select-Object -First 1
            if ($l) { return [int]$l.Matches[0].Groups[1].Value }
        }
    }
    return 3
}

$inv = [Globalization.CultureInfo]::InvariantCulture
$iniMachineBefore = Read-IniMachine
if ($Machine -lt 0) { $Machine = $iniMachineBefore }

try {
    # ---- 0) girdi kontrolu ----
    if (-not (Test-Path -LiteralPath $OrdFile)) { Fail 2 "ORD dosyasi bulunamadi: $OrdFile" }
    if (-not (Test-Path -LiteralPath $Template)) { Fail 4 "Rapor sablonu bulunamadi: $Template (RPT_AN_ALL_AUT_ENG_Perfex.csv dosyasini bu yola koyun)" }
    $OrdFile = (Resolve-Path -LiteralPath $OrdFile).Path
    $Template = (Resolve-Path -LiteralPath $Template).Path
    $outDir = Split-Path -Parent ([IO.Path]::GetFullPath($OutCsv))
    if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    $OutCsv = [IO.Path]::GetFullPath($OutCsv)
    if (Test-Path -LiteralPath $OutCsv) { Remove-Item -LiteralPath $OutCsv -Force }

    # ---- 1) cncKad / AutoNest acik mi? ----
    $gk = @(Get-Process gkadw -ErrorAction SilentlyContinue)
    $an = @(Get-Process AutoNest -ErrorAction SilentlyContinue)
    $withWin = @($gk + $an | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() -ne '' })
    if ($withWin.Count -gt 0) {
        $t = ($withWin | ForEach-Object { "$($_.ProcessName) PID $($_.Id) '$($_.MainWindowTitle)'" }) -join '; '
        Fail 3 "cncKad/AutoNest penceresi acik ($t). Is durduruldu, pencereye dokunulmadi. Lutfen cncKad'i kapatin ve tekrar deneyin."
    }
    if ($gk.Count -gt 0) { Out-Line ("UYARI: penceresiz gkadw calisiyor (PID " + (($gk | ForEach-Object Id) -join ',') + ") - dokunulmadi, sonlandirilmadi.") }

    # ---- ORD oku ----
    $ordDir = Split-Path -Parent $OrdFile
    $ordBase = [IO.Path]::GetFileNameWithoutExtension($OrdFile)
    $items = @()
    $n = 0
    foreach ($line in (Get-Content -LiteralPath $OrdFile -Encoding Default)) {
        $n++
        if ($line.Trim() -eq '') { continue }
        $m = [regex]::Match($line, '^\s*"([^"]*)"\s+"([^"]*)"\s+(\d+)\s+(\d+)(.*)$')
        if (-not $m.Success) { Fail 2 "ORD satir $n cozumlenemedi: $line" }
        $rest = $m.Groups[5].Value
        $mm = [regex]::Match($rest, '@M=(\d+)'); $tm = [regex]::Match($rest, '@T=([0-9.,]+)')
        if (-not $mm.Success -or -not $tm.Success) { Fail 2 "ORD satir $n icinde @M/@T yok: $line" }
        $items += [pscustomobject]@{
            Name = $m.Groups[1].Value; Path = $m.Groups[2].Value
            Qty = [int]$m.Groups[3].Value; Qty2 = [int]$m.Groups[4].Value
            M = [int]$mm.Groups[1].Value
            T = [double]::Parse($tm.Groups[1].Value.Replace(',', '.'), $inv)
        }
    }
    if ($items.Count -eq 0) { Fail 2 "ORD bos: $OrdFile" }

    # malzeme eslemesi (dogrulanmis): @M=0 -> Steel (DKP), @M=3 -> Galvanized Steel
    $matMap = @{ 0 = 'Steel'; 3 = 'Galvanized Steel' }
    $bad = @($items | Where-Object { -not $matMap.ContainsKey($_.M) })
    if ($bad.Count -gt 0) { Fail 2 ("Desteklenmeyen @M malzeme kodu (yalniz 0=Steel, 3=Galvanized Steel dogrulandi): " + (($bad | ForEach-Object { "@M=$($_.M) $($_.Path)" }) -join '; ')) }
    $missingDxf = @($items | Where-Object { -not (Test-Path -LiteralPath $_.Path) })
    if ($missingDxf.Count -gt 0) { Fail 2 ("DXF dosyasi yok: " + (($missingDxf | ForEach-Object Path) -join '; ')) }
    Out-Line "ORD: $($items.Count) satir, makine=$Machine, sac=${SheetX}x${SheetY} x$SheetQty"

    # ---- 2) DXF -> .dft ----
    $BF = [Reflection.BindingFlags]
    $failed = @()
    $dftOf = @{}
    $seen = @{}
    foreach ($it in $items) {
        $key = $it.Path.ToLowerInvariant() + '|' + $it.M + '|' + $it.T
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $dxf = $it.Path
        $trg = [IO.Path]::ChangeExtension($dxf, '.dft')
        # ayni DXF farkli malzeme/kalinlikla gelirse .dft adini benzersiz yap
        $dupe = @($items | Where-Object { $_.Path -ieq $dxf -and ($_.M -ne $it.M -or $_.T -ne $it.T) })
        if ($dupe.Count -gt 0) { $trg = [IO.Path]::Combine([IO.Path]::GetDirectoryName($dxf), ([IO.Path]::GetFileNameWithoutExtension($dxf) + "_M$($it.M)_T$($it.T.ToString($inv))" + '.dft')) }
        if (Test-Path -LiteralPath $trg) { Remove-Item -LiteralPath $trg -Force }
        $mat = $matMap[$it.M]
        $ok = $false; $why = ''
        for ($try = 1; $try -le 3 -and -not $ok; $try++) {
            $p = $null
            try {
                $p = [Activator]::CreateInstance([Type]::GetTypeFromProgID('cncKadPart.Document'))
                [void](Inv $p 'SetCurMachine' @($Machine))
                $r = Inv $p 'ImportFile2' @([string]$dxf, [string]$trg, [string]$mat, [double]$it.T, [int]0)
                if ([int]$r -ne 1) { throw "ImportFile2 dondu: $r" }
                $ac = Inv $p 'AutoCut3' @(0)
                if (-not $ac) { throw 'AutoCut3 sonuc nesnesi dondurmedi' }
                $cut = [int](GetP $ac 'CutContours')
                if ($cut -lt 1) { throw 'AutoCut3: kesim konturu 0' }
                $pm1 = New-Object Reflection.ParameterModifier 2; $pm1[0] = $true
                $sa = [object[]]@([string]$trg, [int16]1)
                [void][System.__ComObject].InvokeMember('InterfaceSave', $BF::InvokeMethod, $null, $p, $sa, @($pm1), $null, $null)
                [void](Inv $p 'CloseFileIfOpened' @([string]$trg))
                if (-not (Test-Path -LiteralPath $trg) -or (Get-Item -LiteralPath $trg).Length -lt 1) { throw '.dft kaydedilmedi' }
                $ok = $true
                Out-Line ("DFT tamam: $([IO.Path]::GetFileName($dxf)) -> $([IO.Path]::GetFileName($trg)) ($mat, $($it.T.ToString($inv)) mm, kontur=$cut)")
            } catch {
                $why = Root-Msg $_.Exception
                Out-Line "DFT deneme $try basarisiz ($([IO.Path]::GetFileName($dxf))): $why"
                Start-Sleep -Milliseconds 800
            } finally {
                if ($p) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($p) } catch {} }
            }
        }
        if ($ok) { $dftOf[$key] = $trg } else { $failed += "$([IO.Path]::GetFileName($dxf)) ($why)" }
    }
    if ($failed.Count -gt 0) { Fail 5 ("DXF import/AutoCut basarisiz " + $failed.Count + " dosya: " + ($failed -join '; ')) }

    # ---- 3) _dft.ORD ----
    $dftOrd = Join-Path $ordDir ($ordBase + '_dft.ORD')
    $out = @()
    foreach ($it in $items) {
        $key = $it.Path.ToLowerInvariant() + '|' + $it.M + '|' + $it.T
        $out += ('"{0}"   "{1}"   {2}   {3}   @M={4}   @T={5}' -f $it.Name, $dftOf[$key], $it.Qty, $it.Qty2, $it.M, $it.T.ToString($inv))
    }
    [IO.File]::WriteAllLines($dftOrd, [string[]]$out, [Text.Encoding]::Default)
    Out-Line "ORD(dft): $dftOrd"

    # ---- 4) AutoNest ----
    $dsp = Join-Path $ordDir ($ordBase + '.dsp')
    if (Test-Path -LiteralPath $dsp) { Remove-Item -LiteralPath $dsp -Force }
    $d = $null
    try {
        try { $d = New-Object -ComObject AutoNest.Document } catch { Fail 6 ("AutoNest.Document olusturulamadi: " + (Root-Msg $_.Exception)) }
        $script:step='AutoNest.SetCurMachine'; [void](Inv $d 'SetCurMachine' @($Machine))
        $script:step='LoadOrdFile2'; $r = Inv $d 'LoadOrdFile2' @([string]$dftOrd, [double]$SheetX, [double]$SheetY, [int]1, [string]$dsp)
        if ([int]$r -ne 1) { Fail 6 "LoadOrdFile2 basarisiz (donus=$r): $dftOrd" }
        $script:step='SheetSizesUseAPISizes'; [void](Inv $d 'SheetSizesUseAPISizes' @(1))
        $script:step='SheetSizesClearAPISizes'; [void](Inv $d 'SheetSizesClearAPISizes')
        $script:step='SheetSizesAddAPISizes'; [void](Inv $d 'SheetSizesAddAPISizes' @([double]$SheetX, [double]$SheetY, [int]$SheetQty))
        $script:step='DoStartAutoNest3'; [void](Inv $d 'DoStartAutoNest3' @(1))
        $script:step='GetTotalSubNests'; $subs = [int](Inv $d 'GetTotalSubNests')
        if ($subs -lt 1) { Fail 6 'Yerlesim uretilemedi (alt yerlesim sayisi 0).' }
        $script:step='Save'; $sv = Inv $d 'Save' @([string]$dsp, $true)
        if (-not (Test-Path -LiteralPath $dsp) -or (Get-Item -LiteralPath $dsp).Length -lt 1) { Fail 6 ".dsp kaydedilemedi (Save donus=$sv): $dsp" }
        Out-Line "Yerlesim tamam: $subs alt yerlesim, .dsp=$dsp"
        $script:step='DoOrderReport'; $rr = Inv $d 'DoOrderReport' @([string]$Template, [string]$OutCsv)
        Out-Line "DoOrderReport donus=$rr"
    } finally {
        if ($d) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($d) } catch {} }
    }

    # ---- 5) CSV dogrula ----
    if (-not (Test-Path -LiteralPath $OutCsv) -or (Get-Item -LiteralPath $OutCsv).Length -lt 1) { Fail 7 "Rapor CSV olusmadi: $OutCsv" }
    $txt = Get-Content -LiteralPath $OutCsv -Raw -Encoding Default
    $ct = [regex]::Match($txt, '(?im)^\s*Total cut time:\s*,\s*([0-9:]+)')
    $pc = [regex]::Match($txt, '(?im)^\s*Total pierces:\s*,\s*(\d+)')
    if (-not $ct.Success -or -not $pc.Success) { Fail 7 "CSV'de 'Total cut time' / 'Total pierces' satirlari yok: $OutCsv" }
    $ctv = $ct.Groups[1].Value; $pcv = [int]$pc.Groups[1].Value
    $ctZero = ((($ctv -replace '[0:]', '')) -eq '')
    if ($ctZero -or $pcv -eq 0) { Fail 7 "CSV gecersiz: toplam kesim suresi=$ctv, pierce=$pcv (0 olamaz). $OutCsv" }
    Out-Line "OZET toplam_kesim_suresi=$ctv pierce=$pcv alt_yerlesim=$subs"
    # ---- 5b) Yerlesmeyen parca kontrolu (cikis kodu 0 kalir; sadece uyari satiri) ----
    $ordM = [regex]::Match($txt, '(?im)^\s*Total ordered parts:\s*,\s*(\d+)')
    $plcM = [regex]::Match($txt, '(?im)^\s*Total Placed Parts:\s*,\s*(\d+)')
    if ($ordM.Success -and $plcM.Success) {
        $ordN = [int]$ordM.Groups[1].Value; $plcN = [int]$plcM.Groups[1].Value
        Out-Line "PARCA siparis=$ordN yerlesen=$plcN"
        if ($plcN -lt $ordN) {
            Write-Output ("UYARI yerlesmeyen parca: " + ($ordN - $plcN))
            Out-Line "UYARI detay: siparis=$ordN yerlesen=$plcN sac_ust_siniri=$SheetQty; -SheetQty degerini artirip yerlesimi yeniden calistirin"
        }
    } else {
        Out-Line "UYARI: CSV'de 'Total ordered parts' / 'Total Placed Parts' satirlari bulunamadi; yerlesim tamamligi dogrulanamadi"
    }
    Write-Output "CSV $OutCsv"
    exit 0
} catch {
    Write-Output ('HATA Beklenmeyen hata (adim: ' + $script:step + '): ' + (Root-Msg $_.Exception))
    exit 8
} finally {
    # SetCurMachine genel ayari degistirmis olabilir: INI degeri degistiyse eski haline getir
    try {
        $now = Read-IniMachine
        if ($now -ne $iniMachineBefore) {
            $q = New-Object -ComObject AutoNest.Document
            [void](Inv $q 'SetCurMachine' @($iniMachineBefore))
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($q)
            Out-Line "CURRENT_MACHINE $now -> $iniMachineBefore geri alindi."
        }
    } catch {}
}
