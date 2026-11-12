"""Pixel difference of two screenshots of the same camera: python3 -I imgdiff.py a.png b.png [out-diff.png]
Prints the share of pixels that differ, the largest channel difference and the mean absolute difference.
Writes an amplified difference image when a third argument is given."""
import sys

from PIL import Image, ImageChops

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print('size differs', a.size, b.size)
    sys.exit(2)
diff = ImageChops.difference(a, b)
pixels = a.size[0] * a.size[1]
data = list(diff.getdata())
changed = sum(1 for p in data if max(p) > 0)
loud = sum(1 for p in data if max(p) > 8)
peak = max(max(p) for p in data)
mean = sum(sum(p) for p in data) / (3 * pixels)
print(f'{changed} of {pixels} pixels differ ({100 * changed / pixels:.3f} %), {loud} by more than 8/255, peak {peak}, mean abs {mean:.4f}')
if len(sys.argv) > 3:
    diff.point(lambda v: min(255, v * 16)).save(sys.argv[3])
