# Reads the application certificate (PFX) once at the worker's start and hands server.mjs its DER
# certificate and PKCS#8 private key on stdout, as one JSON line. Nothing is written to disk: the
# key lives only in the worker's memory, where it signs the Graph client assertions (R-35). The
# password comes from a file (the container's secret), never from the command line.
$ErrorActionPreference = 'Stop'
try {
  $password = (Get-Content -Raw -LiteralPath $env:TENANT_PFX_PASSWORD_FILE) -replace '[\r\n]+$', ''
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
    [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:TENANT_PFX_PATH, $password, $flags)
  $password = $null
  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
  if ($null -eq $rsa) { throw 'The certificate has no RSA private key' }
  $answer = @{ cert = [Convert]::ToBase64String($cert.RawData); key = [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey()) }
  [Console]::Out.WriteLine(($answer | ConvertTo-Json -Compress))
} catch {
  # The exception names what failed (a wrong password, a damaged file), never the password.
  [Console]::Error.WriteLine("certificate_unreadable: $($_.Exception.GetType().Name)")
  exit 1
}
