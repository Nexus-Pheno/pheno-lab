"""Encode a numeric vision calibration tile locally, without fonts or metadata."""
import struct
import sys
import zlib

GLYPHS = (
    "111101101101111", "010110010010111", "111001111100111", "111001111001111",
    "101101111001001", "111100111001111", "111100111101111", "111001010010010",
    "111101111101111", "111101111001111",
)

def tile(token):
    if len(token) != 6 or not token.isascii() or not token.isdigit():
        raise ValueError("invalid visual challenge")
    scale = 12
    width, height = (len(token) * 4 + 1) * scale, 7 * scale
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            row, col = y // scale - 1, x // scale - 1
            index, offset = divmod(col, 4)
            black = 0 <= row < 5 and 0 <= index < len(token) and offset < 3 and GLYPHS[int(token[index])][row * 3 + offset] == "1"
            raw.append(20 if black else 255)
    def chunk(name, body):
        return struct.pack(">I", len(body)) + name + body + struct.pack(">I", zlib.crc32(name + body))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

if __name__ == "__main__":
    sys.stdout.buffer.write(tile(sys.argv[1]))
