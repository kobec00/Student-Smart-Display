#!/usr/bin/env python3
"""Maak een onzichtbaar muispijltje als standaard cursorthema voor deze gebruiker.

cage (de kiosk-compositor) tekent anders een pijltje midden op het scherm, ook al
gebruik je alleen aanraking. Door het thema "default" in ~/.local/share/icons te
vervangen door een doorzichtige cursor van 1x1 pixel ziet niemand het nog.
Ongedaan maken: rm -r ~/.local/share/icons/default
"""
import os
import struct

# Xcursor-bestand: kop, één inhoudsopgave-regel, één afbeelding van 1x1 doorzichtig.
IMAGE = 0xFFFD0002
SIZE = 24
data = (
    struct.pack('<4sIII', b'Xcur', 16, 0x10000, 1)
    + struct.pack('<III', IMAGE, SIZE, 28)
    + struct.pack('<IIIIIIIII', 36, IMAGE, SIZE, 1, 1, 1, 0, 0, 0)
    + struct.pack('<I', 0)
)

NAMES = [
    'default', 'left_ptr', 'pointer', 'hand1', 'hand2', 'text', 'xterm', 'crosshair',
    'wait', 'watch', 'progress', 'left_ptr_watch', 'grab', 'grabbing', 'move', 'fleur',
    'not-allowed', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'all-scroll',
]

base = os.path.expanduser('~/.local/share/icons/default')
cursors = os.path.join(base, 'cursors')
os.makedirs(cursors, exist_ok=True)
with open(os.path.join(cursors, 'default'), 'wb') as f:
    f.write(data)
for name in NAMES[1:]:
    path = os.path.join(cursors, name)
    if os.path.lexists(path):
        os.remove(path)
    os.symlink('default', path)
with open(os.path.join(base, 'index.theme'), 'w') as f:
    f.write('[Icon Theme]\nName=default\nComment=Onzichtbare cursor voor de kiosk\n')
print(f'Onzichtbare cursor geplaatst in {base}')
