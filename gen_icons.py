#!/usr/bin/env python3
"""
gen_icons.py — Generate SlopFilter PNG icons (no dependencies).
Run once: python3 gen_icons.py
"""
import struct, zlib, os

def make_png(size, color=(192, 57, 43)):
    """Create a minimal solid-color square PNG."""
    r, g, b = color
    # Raw image data: one filter byte (0) + RGB pixels per row
    row = bytes([0]) + bytes([r, g, b] * size)
    raw = row * size
    compressed = zlib.compress(raw, 9)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    sig   = b'\x89PNG\r\n\x1a\n'
    ihdr  = chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    idat  = chunk(b'IDAT', compressed)
    iend  = chunk(b'IEND', b'')
    return sig + ihdr + idat + iend

os.makedirs('icons', exist_ok=True)
for sz in (16, 48, 128):
    path = f'icons/icon{sz}.png'
    with open(path, 'wb') as f:
        f.write(make_png(sz))
    print(f'  created {path}')

print('Done.')
