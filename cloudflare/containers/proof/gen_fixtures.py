"""Generate synthetic fixtures inside the ChamPDF image. No user files, no network.

Run: docker run --rm -v <dir>:/fx <image> python /fx/gen_fixtures.py
"""
import io, os, subprocess, zipfile, datetime
import fitz  # PyMuPDF
from PIL import Image, ImageDraw
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

OUT = "/fx/out"
os.makedirs(OUT, exist_ok=True)

# docx (hand-built, valid minimal package) -> convert/to-pdf via LibreOffice
body = "".join(f"<w:p><w:r><w:t>Synthetic paragraph {i} for the container proof.</w:t></w:r></w:p>" for i in range(120))
with zipfile.ZipFile(f"{OUT}/sample.docx", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')

# text PDF (also the PDF that gets signed)
d = fitz.open()
for p in range(10):
    pg = d.new_page()
    pg.insert_text((72, 100), f"ChamPDF synthetic page {p + 1}", fontsize=18)
    for l in range(30):
        pg.insert_text((72, 140 + l * 18), f"Line {l}: lorem ipsum dolor sit amet, consectetur.", fontsize=10)
d.save(f"{OUT}/text10.pdf")

# image-only "scanned" PDF with real glyphs for tesseract
img = Image.new("RGB", (1654, 2339), "white")  # A4 @ 200dpi
dr = ImageDraw.Draw(img)
for l in range(25):
    dr.text((120, 150 + l * 60), f"Scanned line {l} Invoice total 1234.56 ChamPDF OCR proof", fill="black")
buf = io.BytesIO(); img.save(buf, "PNG")
sd = fitz.open(); pg = sd.new_page(width=595, height=842)
pg.insert_image(pg.rect, stream=buf.getvalue()); sd.save(f"{OUT}/scan1.pdf")

# throwaway self-signed signer cert (generated here, never leaves the fixture dir)
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ChamPDF Container Proof")])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=30)).sign(key, hashes.SHA256()))
open(f"{OUT}/signer.p12", "wb").write(pkcs12.serialize_key_and_certificates(b"proof", key, cert, None, serialization.BestAvailableEncryption(b"proofpass")))

# images: opaque photo-like gradient and a transparent RGBA
g = Image.new("RGB", (1024, 1024))
px = g.load()
for x in range(1024):
    for y in range(1024):
        px[x, y] = (x // 4, y // 4, (x + y) // 8)
ImageDraw.Draw(g).ellipse((300, 300, 700, 700), fill=(220, 40, 40))
g.save(f"{OUT}/photo.png")
t = Image.new("RGBA", (512, 512), (0, 0, 0, 0)); ImageDraw.Draw(t).ellipse((50, 50, 460, 460), fill=(20, 120, 220, 180)); t.save(f"{OUT}/transparent.png")

# video: 1080p 30 s synthetic (ffmpeg testsrc2), plus a short 720p one
for name_, size, secs in (("video_720p_5s", "1280x720", 5), ("video_1080p_30s", "1920x1080", 30)):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration={secs}",
                    "-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-c:a", "aac", "-shortest", f"{OUT}/{name_}.mp4"], check=True)
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(f"{OUT}/{f}"))
