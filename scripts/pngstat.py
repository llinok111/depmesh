"""自解码 PNG 做像素统计 —— 本机读图工具不可靠，所以自己算。

判定「不是空帧/白屏/半渲染」的四条阈值：
  1. 尺寸符合预期（宽 >= 1200，高 >= 600）
  2. 去重颜色数 >= 200（空帧只有 1-2 种颜色）
  3. 平均亮度在 5..250 之间（纯黑/纯白都不合格）
  4. 四段水平分带的亮度标准差都 > 2（说明画面各处都有内容，而非整片纯色）
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path


def decode_png(path: Path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    pos = 8
    width = height = bitdepth = colortype = None
    idat = bytearray()
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, bitdepth, colortype = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    assert bitdepth == 8, f"只支持 8bit，实际 {bitdepth}"
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(height * stride)
    prev = bytearray(stride)
    idx = 0
    for y in range(height):
        ftype = raw[idx]
        idx += 1
        line = bytearray(raw[idx : idx + stride])
        idx += stride
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return width, height, channels, bytes(out)


def stats(path: Path) -> dict:
    width, height, channels, pixels = decode_png(path)
    colors = set()
    lums = []
    band_lums = [[], [], [], []]
    step = max(1, (width * height) // 40000)
    for pi in range(0, width * height, step):
        off = pi * channels
        r, g, b = pixels[off], pixels[off + 1], pixels[off + 2]
        colors.add((r >> 3, g >> 3, b >> 3))
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        lums.append(lum)
        band_lums[min(3, pi // max(1, (width * height // 4)))].append(lum)

    def sd(values):
        if len(values) < 2:
            return 0.0
        mean = sum(values) / len(values)
        return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5

    return {
        "file": path.name,
        "width": width,
        "height": height,
        "samples": len(lums),
        "unique_colors": len(colors),
        "mean_lum": round(sum(lums) / len(lums), 1),
        "band_sd": [round(sd(b), 1) for b in band_lums],
    }


def main(argv: list[str]) -> int:
    min_w, min_h = 1200, 600
    args = list(argv)
    if "--min-size" in args:
        i = args.index("--min-size")
        min_w, min_h = (int(x) for x in args[i + 1].split("x"))
        del args[i : i + 2]
    paths = [Path(p) for p in args] or sorted(Path("shots").glob("*.png"))
    failures = 0
    print(f"{'文件':<22}{'尺寸':<12}{'色数':>6}{'亮度':>7}  分带标准差   (阈值 {min_w}x{min_h})")
    for p in paths:
        if not p.is_file():
            continue
        s = stats(p)
        ok = (
            s["width"] >= min_w
            and s["height"] >= min_h
            and s["unique_colors"] >= 200
            and 5 <= s["mean_lum"] <= 250
            and min(s["band_sd"]) > 2
        )
        if not ok:
            failures += 1
        print(
            f"{s['file']:<22}{str(s['width']) + 'x' + str(s['height']):<12}"
            f"{s['unique_colors']:>6}{s['mean_lum']:>7}  {s['band_sd']}  {'OK' if ok else 'SUSPECT'}"
        )
    print(f"\n共 {len(paths)} 张，可疑 {failures} 张")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
