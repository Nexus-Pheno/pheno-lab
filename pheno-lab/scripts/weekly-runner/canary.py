"""Render six random digits using a standard PDF font; the PNG contains no answer metadata."""

import re
import struct
import subprocess
import sys


def tile(token):
    if not re.fullmatch(r"[0-9]{6}", token):
        raise ValueError("Invalid visual calibration token")
    stream = f"BT /F1 65 Tf 8 Tc 30 31 Td ({token}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 115] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(pdf)
    pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
    for n in offsets:
        pdf.extend(f"{n:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    )
    png = subprocess.run(
        ["pdftoppm", "-png", "-singlefile", "-r", "144", "-"],
        input=pdf,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=10,
        check=True,
    ).stdout
    if png[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", png[16:24]) != (
        720,
        230,
    ):
        raise ValueError("Calibration rendering failed")
    return png


if __name__ == "__main__":
    sys.stdout.buffer.write(tile(sys.argv[1]))
