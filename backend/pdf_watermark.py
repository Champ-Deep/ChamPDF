from __future__ import annotations

import io
import math
import statistics
import zlib

import numpy as np
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

try:
    import pikepdf
except ImportError:
    pikepdf = None

Matrix = Tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

AUTO_THRESHOLD = 3
REGION_THRESHOLD = 2
DEFINITE = 100

TEXT_SHOW = {"Tj", "TJ", "'", '"'}
PATH_PAINT = {"f", "F", "f*", "B", "B*", "b", "b*", "S", "s"}
PATH_BUILD = {"m", "l", "c", "v", "y", "re", "h"}

_BASE14_AVG = {"courier": 600.0, "times": 500.0, "helvetica": 556.0, "arial": 556.0, "symbol": 550.0}


class WatermarkError(Exception):
    pass


def watermark_removal_available() -> bool:
    return pikepdf is not None


def mul(m1: Matrix, m2: Matrix) -> Matrix:
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def apply(m: Matrix, x: float, y: float) -> Tuple[float, float]:
    a, b, c, d, e, f = m
    return a * x + c * y + e, b * x + d * y + f


def bbox_of(points: Sequence[Tuple[float, float]]) -> Tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def _num(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _is_dict(v: Any) -> bool:
    return pikepdf is not None and isinstance(v, pikepdf.Dictionary)


@dataclass
class PageGeometry:
    x0: float
    y0: float
    x1: float
    y1: float
    rotate: int

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0

    def to_view(self, x: float, y: float) -> Tuple[float, float]:
        u, v = x - self.x0, self.y1 - y
        w, h = self.width, self.height
        if self.rotate == 90:
            return (h - v) / h, u / w
        if self.rotate == 180:
            return (w - u) / w, (h - v) / h
        if self.rotate == 270:
            return v / h, (w - u) / w
        return u / w, v / h

    def bbox_to_fractions(self, bbox: Tuple[float, float, float, float]) -> Dict[str, float]:
        x0, y0, x1, y1 = bbox
        pts = [self.to_view(x, y) for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
        fx0, fy0, fx1, fy1 = bbox_of(pts)
        fx0, fy0 = max(0.0, fx0), max(0.0, fy0)
        fx1, fy1 = min(1.0, fx1), min(1.0, fy1)
        return {"x": fx0, "y": fy0, "width": max(0.0, fx1 - fx0), "height": max(0.0, fy1 - fy0)}


def overlap_ratio(item: Dict[str, float], region: Dict[str, float]) -> float:
    ix0, iy0 = item["x"], item["y"]
    ix1, iy1 = ix0 + item["width"], iy0 + item["height"]
    rx0, ry0 = region["x"], region["y"]
    rx1, ry1 = rx0 + region["width"], ry0 + region["height"]
    w = max(0.0, min(ix1, rx1) - max(ix0, rx0))
    h = max(0.0, min(iy1, ry1) - max(iy0, ry0))
    return (w * h) / max(item["width"] * item["height"], 1e-9)


class FontMetrics:
    def __init__(self, font: Any):
        self.two_byte = False
        self.widths: Dict[int, float] = {}
        self.default = 500.0
        self.scale = 1.0 / 1000.0
        if not _is_dict(font):
            return
        subtype = str(font.get("/Subtype", ""))
        if subtype == "/Type0":
            self.two_byte = True
            self.default = 1000.0
            desc = font.get("/DescendantFonts")
            desc = desc[0] if desc is not None and len(desc) else None
            if _is_dict(desc):
                self.default = _num(desc.get("/DW", 1000), 1000.0)
                w = desc.get("/W")
                if w is not None:
                    self._parse_w(list(w))
            return
        if subtype == "/Type3":
            fm = font.get("/FontMatrix")
            if fm is not None:
                self.scale = _num(fm[0], 0.001)
        first = int(_num(font.get("/FirstChar", 0)))
        widths = font.get("/Widths")
        if widths is not None:
            for i, wv in enumerate(widths):
                self.widths[first + i] = _num(wv)
        fd = font.get("/FontDescriptor")
        missing = _num(fd.get("/MissingWidth", 0)) if _is_dict(fd) else 0.0
        if missing:
            self.default = missing
        elif widths is None:
            base = str(font.get("/BaseFont", "")).lower()
            self.default = next((v for k, v in _BASE14_AVG.items() if k in base), 500.0)
        else:
            vals = [v for v in self.widths.values() if v > 0]
            self.default = statistics.median(vals) if vals else 500.0

    def _parse_w(self, w: List[Any]) -> None:
        i = 0
        while i < len(w):
            start = int(_num(w[i]))
            nxt = w[i + 1] if i + 1 < len(w) else None
            if isinstance(nxt, pikepdf.Array):
                for j, wv in enumerate(nxt):
                    self.widths[start + j] = _num(wv)
                i += 2
                continue
            if i + 2 < len(w):
                end, wv = int(_num(w[i + 1])), _num(w[i + 2])
                for code in range(start, min(end, start + 65535) + 1):
                    self.widths[code] = wv
            i += 3

    def codes(self, data: bytes) -> List[int]:
        if self.two_byte:
            return [(data[i] << 8) | (data[i + 1] if i + 1 < len(data) else 0) for i in range(0, len(data), 2)]
        return list(data)

    def width(self, code: int) -> float:
        return self.widths.get(code, self.default) * self.scale


@dataclass
class GState:
    ctm: Matrix = IDENTITY
    fill_alpha: float = 1.0
    stroke_alpha: float = 1.0
    fill_rgb: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    font_key: str = ""
    font: Any = None
    font_size: float = 0.0
    char_spacing: float = 0.0
    word_spacing: float = 0.0
    hscale: float = 1.0
    leading: float = 0.0
    rise: float = 0.0

    def copy(self) -> "GState":
        return GState(**self.__dict__)


@dataclass
class Item:
    page: int
    index: int
    kind: str
    bbox: Tuple[float, float, float, float]
    alpha: float
    fill_rgb: Tuple[float, float, float] = (0.0, 0.0, 0.0)
    size: float = 0.0
    angle: float = 0.0
    glyphs: int = 0
    raw: bytes = b""
    text: str = ""
    advance: float = 0.0
    font_size: float = 0.0
    hscale: float = 1.0
    xobject: Any = None
    xobject_name: str = ""
    marked_watermark: bool = False
    tagged_watermark: bool = False
    image_matrix: Matrix = IDENTITY
    score: int = 0
    reasons: List[str] = field(default_factory=list)
    frac: Dict[str, float] = field(default_factory=dict)


def _inherited(page_obj: Any, key: str) -> Any:
    node = page_obj
    for _ in range(32):
        if not _is_dict(node):
            return None
        val = node.get(key)
        if val is not None:
            return val
        node = node.get("/Parent")
    return None


def _rgb_from(op: str, operands: List[Any]) -> Optional[Tuple[float, float, float]]:
    vals = [_num(v) for v in operands if isinstance(v, (int, float)) or hasattr(v, "as_integer_ratio")]
    if op == "g" and vals:
        return (vals[0],) * 3
    if op == "rg" and len(vals) >= 3:
        return vals[0], vals[1], vals[2]
    if op == "k" and len(vals) >= 4:
        c, m, y, k = vals[:4]
        return (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    if op in ("sc", "scn") and vals:
        if len(vals) == 1:
            return (vals[0],) * 3
        if len(vals) == 3:
            return vals[0], vals[1], vals[2]
        if len(vals) == 4:
            c, m, y, k = vals
            return (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)
    return None


def _name_says_watermark(obj: Any) -> bool:
    return _is_dict(obj) and "watermark" in str(obj.get("/Name", "")).lower()


def _ocg_is_watermark(props: Any, resources: Any) -> bool:
    if not _is_dict(props):
        prop_dict = resources.get("/Properties") if _is_dict(resources) else None
        props = prop_dict.get(str(props)) if _is_dict(prop_dict) else None
    if not _is_dict(props):
        return False
    if _name_says_watermark(props):
        return True
    ocgs = props.get("/OCGs")
    if isinstance(ocgs, pikepdf.Array):
        return any(_name_says_watermark(o) for o in ocgs)
    return _name_says_watermark(ocgs)


def _form_has_transparency(xobj: Any) -> bool:
    res = xobj.get("/Resources")
    gs = res.get("/ExtGState") if _is_dict(res) else None
    if not _is_dict(gs):
        return False
    for key in gs.keys():
        g = gs[key]
        if _is_dict(g) and (_num(g.get("/ca", 1), 1) < 0.95 or _num(g.get("/CA", 1), 1) < 0.95):
            return True
    return False


def _form_tagged_watermark(xobj: Any) -> bool:
    piece = xobj.get("/PieceInfo")
    if not _is_dict(piece):
        return False
    for key in piece.keys():
        entry = piece[key]
        if not _is_dict(entry):
            continue
        if "watermark" in str(entry.get("/Private", "")).lower():
            return True
        if "watermark" in str(entry.get("/ADBE_CompoundType", "")).lower():
            return True
    return False


def _text_segments(op: str, operands: List[Any]) -> List[Any]:
    if op == "TJ" and operands:
        return [bytes(s) if isinstance(s, pikepdf.String) else s for s in operands[0]]
    last = operands[-1] if operands else b""
    return [bytes(last)]


def interpret(page_index: int, instructions: List[Any], resources: Any) -> List[Item]:
    items: List[Item] = []
    gs = GState()
    stack: List[GState] = []
    tm: Matrix = IDENTITY
    tlm: Matrix = IDENTITY
    marked: List[bool] = []
    path_pts: List[Tuple[float, float]] = []
    fonts: Dict[str, FontMetrics] = {}
    font_res = resources.get("/Font") if _is_dict(resources) else None
    gs_res = resources.get("/ExtGState") if _is_dict(resources) else None
    xo_res = resources.get("/XObject") if _is_dict(resources) else None

    def metrics() -> FontMetrics:
        if gs.font_key not in fonts:
            fonts[gs.font_key] = FontMetrics(gs.font)
        return fonts[gs.font_key]

    def show(index: int, segments: List[Any]) -> None:
        nonlocal tm
        fm = metrics()
        fs, th = gs.font_size, gs.hscale
        advance = 0.0
        raw = b""
        glyphs = 0
        for seg in segments:
            if isinstance(seg, (bytes, bytearray)):
                raw += bytes(seg)
                for code in fm.codes(bytes(seg)):
                    w = fm.width(code) * fs + gs.char_spacing
                    if not fm.two_byte and code == 32:
                        w += gs.word_spacing
                    advance += w * th
                    glyphs += 1
            else:
                advance -= _num(seg) / 1000.0 * fs * th
        trm = mul((1.0, 0.0, 0.0, 1.0, 0.0, gs.rise), mul(tm, gs.ctm))
        lo, hi = -0.22 * fs, 0.9 * fs
        pts = [apply(trm, 0, lo), apply(trm, advance, lo), apply(trm, 0, hi), apply(trm, advance, hi)]
        scale = math.sqrt(abs(trm[0] * trm[3] - trm[1] * trm[2])) or 1.0
        items.append(Item(
            page=page_index, index=index, kind="text", bbox=bbox_of(pts), alpha=gs.fill_alpha,
            fill_rgb=gs.fill_rgb, size=abs(fs) * scale, angle=math.degrees(math.atan2(trm[1], trm[0])),
            glyphs=glyphs, raw=raw, text="" if fm.two_byte else raw.decode("latin-1"),
            advance=advance, font_size=fs, hscale=th, marked_watermark=any(marked),
        ))
        tm = mul((1.0, 0.0, 0.0, 1.0, advance, 0.0), tm)

    for index, ins in enumerate(instructions):
        op = str(ins.operator)
        operands = list(ins.operands)
        if op == "q":
            stack.append(gs.copy())
        elif op == "Q":
            if stack:
                gs = stack.pop()
        elif op == "cm" and len(operands) == 6:
            gs.ctm = mul(tuple(_num(v) for v in operands), gs.ctm)
        elif op == "gs" and operands and _is_dict(gs_res):
            g = gs_res.get(str(operands[0]))
            if _is_dict(g):
                if "/ca" in g:
                    gs.fill_alpha = _num(g.get("/ca"), 1.0)
                if "/CA" in g:
                    gs.stroke_alpha = _num(g.get("/CA"), 1.0)
        elif op in ("g", "rg", "k", "sc", "scn"):
            rgb = _rgb_from(op, operands)
            if rgb is not None:
                gs.fill_rgb = rgb
        elif op in ("BDC", "BMC"):
            tag = str(operands[0]) if operands else ""
            flag = False
            if op == "BDC" and len(operands) > 1:
                props = operands[1]
                if tag == "/Artifact" and _is_dict(props):
                    flag = "watermark" in str(props.get("/Subtype", "")).lower()
                elif tag == "/OC":
                    flag = _ocg_is_watermark(props, resources)
            marked.append(flag)
        elif op == "EMC":
            if marked:
                marked.pop()
        elif op == "BT":
            tm = tlm = IDENTITY
        elif op == "Tf" and len(operands) == 2:
            gs.font_key = str(operands[0])
            gs.font = font_res.get(gs.font_key) if _is_dict(font_res) else None
            gs.font_size = _num(operands[1])
        elif op == "Tc" and operands:
            gs.char_spacing = _num(operands[0])
        elif op == "Tw" and operands:
            gs.word_spacing = _num(operands[0])
        elif op == "Tz" and operands:
            gs.hscale = _num(operands[0], 100.0) / 100.0
        elif op == "TL" and operands:
            gs.leading = _num(operands[0])
        elif op == "Ts" and operands:
            gs.rise = _num(operands[0])
        elif op in ("Td", "TD") and len(operands) == 2:
            tx, ty = _num(operands[0]), _num(operands[1])
            if op == "TD":
                gs.leading = -ty
            tlm = mul((1.0, 0.0, 0.0, 1.0, tx, ty), tlm)
            tm = tlm
        elif op == "Tm" and len(operands) == 6:
            tlm = tuple(_num(v) for v in operands)
            tm = tlm
        elif op == "T*":
            tlm = mul((1.0, 0.0, 0.0, 1.0, 0.0, -gs.leading), tlm)
            tm = tlm
        elif op in TEXT_SHOW:
            if op in ("'", '"'):
                if op == '"' and len(operands) == 3:
                    gs.word_spacing = _num(operands[0])
                    gs.char_spacing = _num(operands[1])
                tlm = mul((1.0, 0.0, 0.0, 1.0, 0.0, -gs.leading), tlm)
                tm = tlm
            show(index, _text_segments(op, operands))
        elif op in PATH_BUILD:
            vals = [_num(v) for v in operands]
            if op == "re" and len(vals) == 4:
                x, y, w, h = vals
                path_pts.extend(apply(gs.ctm, px, py) for px, py in ((x, y), (x + w, y), (x, y + h), (x + w, y + h)))
            else:
                for i in range(0, len(vals) - 1, 2):
                    path_pts.append(apply(gs.ctm, vals[i], vals[i + 1]))
        elif op in PATH_PAINT or op == "n":
            if op != "n" and path_pts:
                stroke_only = op in ("S", "s")
                items.append(Item(
                    page=page_index, index=index, kind="path", bbox=bbox_of(path_pts),
                    alpha=gs.stroke_alpha if stroke_only else gs.fill_alpha, fill_rgb=gs.fill_rgb,
                    marked_watermark=any(marked),
                ))
            path_pts = []
        elif op == "Do" and operands and _is_dict(xo_res):
            name = str(operands[0])
            xobj = xo_res.get(name)
            if not isinstance(xobj, pikepdf.Stream):
                continue
            subtype = str(xobj.get("/Subtype", ""))
            if subtype == "/Image":
                pts = [apply(gs.ctm, x, y) for x, y in ((0, 0), (1, 0), (0, 1), (1, 1))]
                items.append(Item(
                    page=page_index, index=index, kind="image", bbox=bbox_of(pts), alpha=gs.fill_alpha,
                    xobject=xobj, xobject_name=name, marked_watermark=any(marked), image_matrix=gs.ctm,
                ))
            elif subtype == "/Form":
                fbbox = [_num(v) for v in xobj.get("/BBox", [0, 0, 0, 0])]
                fmat = tuple(_num(v) for v in xobj.get("/Matrix", list(IDENTITY)))
                m = mul(fmat, gs.ctm)
                pts = [apply(m, x, y) for x, y in ((fbbox[0], fbbox[1]), (fbbox[2], fbbox[1]),
                                                     (fbbox[0], fbbox[3]), (fbbox[2], fbbox[3]))]
                items.append(Item(
                    page=page_index, index=index, kind="form", bbox=bbox_of(pts),
                    alpha=min(gs.fill_alpha, 0.5) if _form_has_transparency(xobj) else gs.fill_alpha,
                    xobject=xobj, xobject_name=name, marked_watermark=any(marked),
                    tagged_watermark=_form_tagged_watermark(xobj),
                ))
    return items


def _smask_translucent(xobj: Any) -> bool:
    smask = xobj.get("/SMask")
    if not isinstance(smask, pikepdf.Stream):
        return False
    try:
        alpha = np.asarray(pikepdf.PdfImage(smask).as_pil_image().convert("L"))
    except Exception:
        return False
    visible = alpha > 8
    if not visible.any():
        return False
    return float((alpha[visible] < 230).mean()) >= 0.6


def _area(bbox: Tuple[float, float, float, float]) -> float:
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])


def _signature(item: Item) -> Tuple[Any, ...]:
    f = item.frac
    pos = (round(f.get("x", 0) * 50), round(f.get("y", 0) * 50))
    if item.kind == "text":
        return ("text", item.raw, round(item.size), pos)
    size = (round(f.get("width", 0) * 50), round(f.get("height", 0) * 50))
    if item.kind in ("image", "form"):
        return (item.kind, item.xobject.objgen, pos, size)
    return ("path", pos, size)


def score_items(pages: List[Tuple[PageGeometry, List[Item]]]) -> None:
    page_count = len(pages)
    sig_pages: Dict[Tuple[Any, ...], set] = {}
    for geom, items in pages:
        for it in items:
            it.frac = geom.bbox_to_fractions(it.bbox)
            sig_pages.setdefault(_signature(it), set()).add(it.page)
    repeat_floor = max(2, math.ceil(page_count * 0.6))

    for geom, items in pages:
        sizes = [it.size for it in items if it.kind == "text" and it.glyphs]
        body = statistics.median(sizes) if sizes else 0.0
        page_area = max(geom.width * geom.height, 1.0)
        for it in items:
            if it.marked_watermark:
                it.score, it.reasons = DEFINITE, ["tagged as a watermark artifact or layer"]
                continue
            if it.tagged_watermark:
                it.score, it.reasons = DEFINITE, ["Acrobat watermark object"]
                continue
            if it.kind == "image" and _area(it.bbox) >= 0.7 * page_area:
                continue
            if it.kind == "path" and _area(it.bbox) >= 0.9 * page_area:
                continue
            s, why = 0, []
            if it.alpha < 0.95:
                s += 2
                why.append(f"{round(it.alpha * 100)}% opacity")
            elif it.kind == "image" and _smask_translucent(it.xobject):
                s += 2
                why.append("translucent image")
            if page_count >= 2 and len(sig_pages.get(_signature(it), ())) >= repeat_floor:
                s += 2
                why.append("repeated on most pages")
            if it.kind == "text":
                tilt = abs(it.angle) % 90
                if 5 < tilt < 85:
                    s += 2
                    why.append(f"rotated {round(it.angle)} degrees")
                if body and it.size >= max(24.0, 2.2 * body):
                    s += 2
                    why.append(f"{round(it.size)}pt over {round(body)}pt body text")
                r, g, b = it.fill_rgb
                if s and 0.55 <= 0.299 * r + 0.587 * g + 0.114 * b < 0.97:
                    s += 1
                    why.append("light colour")
            elif not _central(it.frac):
                s = min(s, REGION_THRESHOLD)
            it.score, it.reasons = s, why


def _central(frac: Dict[str, float]) -> bool:
    cx = frac.get("x", 0) + frac.get("width", 0) / 2
    cy = frac.get("y", 0) + frac.get("height", 0) / 2
    return 0.2 <= cx <= 0.8 and 0.2 <= cy <= 0.8


def _open(pdf_bytes: bytes):
    if pikepdf is None:
        raise WatermarkError("Watermark removal needs pikepdf on the server.")
    try:
        return pikepdf.open(io.BytesIO(pdf_bytes))
    except pikepdf.PasswordError:
        raise WatermarkError("This PDF is password protected. Unlock it first.")
    except Exception as e:
        raise WatermarkError(f"Could not read this PDF: {e}")


def _analyse(pdf: Any) -> List[Tuple[PageGeometry, List[Item], List[Any], Any]]:
    out = []
    for i, page in enumerate(pdf.pages):
        obj = page.obj
        box = _inherited(obj, "/CropBox") or _inherited(obj, "/MediaBox") or [0, 0, 612, 792]
        vals = [_num(v) for v in box]
        geom = PageGeometry(min(vals[0], vals[2]), min(vals[1], vals[3]), max(vals[0], vals[2]),
                            max(vals[1], vals[3]), int(_num(_inherited(obj, "/Rotate") or 0)) % 360)
        resources = _inherited(obj, "/Resources")
        try:
            instructions = pikepdf.parse_content_stream(page)
        except Exception:
            instructions = []
        out.append((geom, interpret(i, instructions, resources), instructions, resources))
    score_items([(g, items) for g, items, _, _ in out])
    return out


def _candidate_view(it: Item) -> Dict[str, Any]:
    return {
        "pageIndex": it.page,
        "kind": it.kind,
        "x": it.frac["x"], "y": it.frac["y"], "width": it.frac["width"], "height": it.frac["height"],
        "score": it.score,
        "reasons": it.reasons,
        "text": it.text.strip()[:40] if it.kind == "text" else "",
    }


def _touching(a: Dict[str, Any], b: Dict[str, Any], pad: float = 0.01) -> bool:
    return (a["pageIndex"] == b["pageIndex"]
            and b["x"] <= a["x"] + a["width"] + pad and a["x"] <= b["x"] + b["width"] + pad
            and b["y"] <= a["y"] + a["height"] + pad and a["y"] <= b["y"] + b["height"] + pad)


def _merge_boxes(cands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    for c in sorted(cands, key=lambda c: (c["pageIndex"], c["y"], c["x"])):
        target = next((m for m in merged if _touching(m, c)), None)
        if target is None:
            merged.append({**c, "parts": 1})
            continue
        x0, y0 = min(target["x"], c["x"]), min(target["y"], c["y"])
        x1 = max(target["x"] + target["width"], c["x"] + c["width"])
        y1 = max(target["y"] + target["height"], c["y"] + c["height"])
        target.update(x=x0, y=y0, width=x1 - x0, height=y1 - y0, score=max(target["score"], c["score"]))
        target["reasons"] = sorted(set(target["reasons"]) | set(c["reasons"]))
        target["parts"] += 1
        if c["text"] and c["text"] not in target["text"]:
            target["text"] = (target["text"] + " " + c["text"]).strip()[:60]
    return merged


def detect(pdf_bytes: bytes) -> Dict[str, Any]:
    pdf = _open(pdf_bytes)
    try:
        analysed = _analyse(pdf)
        cands = [_candidate_view(it) for _, items, _, _ in analysed for it in items if it.score >= AUTO_THRESHOLD]
        image_pages = [
            i for i, (geom, items, _, _) in enumerate(analysed)
            if any(it.kind == "image" and _area(it.bbox) >= 0.7 * geom.width * geom.height for it in items)
        ]
        return {"pageCount": len(analysed), "regions": _merge_boxes(cands), "imagePages": image_pages}
    finally:
        pdf.close()


def _replacement(it: Item, instruction: Any) -> List[Any]:
    op = str(instruction.operator)
    out: List[Any] = []
    if op == '"':
        a = list(instruction.operands)
        out.append(pikepdf.ContentStreamInstruction([a[0]], pikepdf.Operator("Tw")))
        out.append(pikepdf.ContentStreamInstruction([a[1]], pikepdf.Operator("Tc")))
    if op in ("'", '"'):
        out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("T*")))
    denom = it.font_size * it.hscale
    if denom and it.advance:
        shift = round(-it.advance * 1000.0 / denom, 3)
        out.append(pikepdf.ContentStreamInstruction([pikepdf.Array([shift])], pikepdf.Operator("TJ")))
    return out


def _region_selection(items: List[Item], regions: List[Dict[str, float]]) -> Tuple[set, List[Dict[str, float]]]:
    chosen: set = set()
    unmatched: List[Dict[str, float]] = []
    for region in regions:
        hits = [it for it in items if overlap_ratio(it.frac, region) >= 0.5]
        marks = [it for it in hits if it.score >= AUTO_THRESHOLD]
        if not marks:
            marks = [it for it in hits if it.score >= REGION_THRESHOLD]
        if not marks:
            marks = [it for it in hits if it.kind != "image" and overlap_ratio(it.frac, region) >= 0.9]
        if marks:
            chosen.update(id(it) for it in marks)
        else:
            unmatched.append(region)
    return chosen, unmatched


def _region_on_image(it: Item, geom: PageGeometry, region: Dict[str, float]) -> Optional[Tuple[int, int, int, int]]:
    a, b, c, d, e, f = it.image_matrix
    if abs(b) > 1e-6 or abs(c) > 1e-6 or geom.rotate or not a or not d:
        return None
    try:
        w, h = int(it.xobject.Width), int(it.xobject.Height)
    except Exception:
        return None
    pts = []
    for fx, fy in ((region["x"], region["y"]), (region["x"] + region["width"], region["y"] + region["height"])):
        ux = geom.x0 + fx * geom.width
        uy = geom.y1 - fy * geom.height
        pts.append(((ux - e) / a * w, (1 - (uy - f) / d) * h))
    x0, x1 = sorted((pts[0][0], pts[1][0]))
    y0, y1 = sorted((pts[0][1], pts[1][1]))
    x0, y0 = max(0, int(math.floor(x0))), max(0, int(math.floor(y0)))
    x1, y1 = min(w, int(math.ceil(x1))), min(h, int(math.ceil(y1)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return x0, y0, x1, y1


def _inpaint_window(rgb: Any, box: Tuple[int, int, int, int], inpaint: Callable[[bytes, bytes], bytes]) -> Any:
    from PIL import Image, ImageFilter

    x0, y0, x1, y1 = box
    margin = max(64, x1 - x0, y1 - y0)
    cx0, cy0 = max(0, x0 - margin), max(0, y0 - margin)
    cx1, cy1 = min(rgb.width, x1 + margin), min(rgb.height, y1 + margin)
    window = rgb.crop((cx0, cy0, cx1, cy1))
    grow = 4
    mask = Image.new("L", window.size, 0)
    mask.paste(255, (max(0, x0 - cx0 - grow), max(0, y0 - cy0 - grow),
                     min(window.width, x1 - cx0 + grow), min(window.height, y1 - cy0 + grow)))
    buf_img, buf_mask = io.BytesIO(), io.BytesIO()
    window.save(buf_img, "PNG")
    mask.save(buf_mask, "PNG")
    out = Image.open(io.BytesIO(inpaint(buf_img.getvalue(), buf_mask.getvalue()))).convert("RGB")
    if out.width >= window.width and out.height >= window.height:
        out = out.crop((0, 0, window.width, window.height))
    else:
        out = out.resize(window.size)
    blended = Image.composite(out, window, mask.filter(ImageFilter.GaussianBlur(grow)))
    result = rgb.copy()
    result.paste(blended, (cx0, cy0))
    return result


def _clear_document_marks(rgb: Any, box: Tuple[int, int, int, int]) -> Any:
    from PIL import Image

    x0, y0, x1, y1 = box
    arr = np.asarray(rgb).copy()
    region = arr[y0:y1, x0:x1].astype(np.float32)
    lum = region[..., 0] * 0.299 + region[..., 1] * 0.587 + region[..., 2] * 0.114
    paper = float(np.percentile(lum, 95))
    ink = float(np.percentile(lum, 2))
    if paper < 170 or paper - ink < 40:
        return None
    ceiling = min(ink + 0.45 * (paper - ink), paper * 0.55)
    is_ink = lum <= ceiling
    padded = np.pad(is_ink, 1)
    near_ink = np.zeros_like(is_ink)
    h, w = is_ink.shape
    for dy in range(3):
        for dx in range(3):
            near_ink |= padded[dy:dy + h, dx:dx + w]
    paper_colour = region[lum >= paper - 2].mean(axis=0)
    clear = ~near_ink & (lum < paper - 10)
    region[clear] = paper_colour
    arr[y0:y1, x0:x1] = region.round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def _patch_image(pdf: Any, page: Any, it: Item, box: Tuple[int, int, int, int],
                 inpaint: Callable[[bytes, bytes], bytes]) -> bool:
    try:
        pil = pikepdf.PdfImage(it.xobject).as_pil_image()
    except Exception:
        return False
    grey = pil.mode in ("L", "1")
    rgb = pil.convert("RGB")
    x0, y0, x1, y1 = box
    cleared = None
    if (x1 - x0) * (y1 - y0) >= 0.06 * rgb.width * rgb.height:
        cleared = _clear_document_marks(rgb, box)
    rgb = cleared if cleared is not None else _inpaint_window(rgb, box, inpaint)
    if grey:
        rgb = rgb.convert("L")

    old = it.xobject
    is_jpeg = "DCTDecode" in str(old.get("/Filter", ""))
    if is_jpeg:
        data = io.BytesIO()
        rgb.save(data, "JPEG", quality=92, subsampling=0)
        payload = data.getvalue()
    else:
        payload = zlib.compress(rgb.tobytes(), 9)
    new = pikepdf.Stream(pdf, payload)
    new.Type = pikepdf.Name.XObject
    new.Subtype = pikepdf.Name.Image
    new.Width, new.Height = rgb.size
    new.BitsPerComponent = 8
    new.ColorSpace = pikepdf.Name.DeviceGray if grey else pikepdf.Name.DeviceRGB
    new.Filter = pikepdf.Name.DCTDecode if is_jpeg else pikepdf.Name.FlateDecode
    for key in ("/SMask", "/Interpolate", "/Intent"):
        if key in old:
            new[key] = old[key]

    resources = _inherited(page.obj, "/Resources")
    local_res = pikepdf.Dictionary({k: resources[k] for k in resources.keys()})
    xobjects = resources.get("/XObject")
    local_xo = pikepdf.Dictionary({k: xobjects[k] for k in xobjects.keys()})
    local_xo[it.xobject_name] = pdf.make_indirect(new)
    local_res.XObject = local_xo
    page.obj.Resources = local_res
    return True


def remove(pdf_bytes: bytes, regions: Optional[List[Dict[str, Any]]] = None,
           inpaint: Optional[Callable[[bytes, bytes], bytes]] = None) -> Tuple[bytes, Dict[str, Any]]:
    pdf = _open(pdf_bytes)
    try:
        analysed = _analyse(pdf)
        report: Dict[str, Any] = {"removed": 0, "imagePatches": 0, "pages": [], "unmatched": []}
        for page_index, (geom, items, instructions, _resources) in enumerate(analysed):
            page = pdf.pages[page_index]
            if regions is None:
                chosen, unmatched = {id(it) for it in items if it.score >= AUTO_THRESHOLD}, []
            else:
                page_regions = [r for r in regions if int(r.get("pageIndex", -1)) == page_index]
                chosen, unmatched = _region_selection(items, page_regions)

            patched = 0
            for region in unmatched:
                done = False
                if inpaint is not None:
                    for it in items:
                        if it.kind != "image" or overlap_ratio(region, it.frac) <= 0:
                            continue
                        box = _region_on_image(it, geom, region)
                        if box and _patch_image(pdf, page, it, box, inpaint):
                            patched += 1
                            done = True
                if not done:
                    report["unmatched"].append(
                        {"pageIndex": page_index, **{k: float(region[k]) for k in ("x", "y", "width", "height")}})

            remove_at = {it.index: it for it in items if id(it) in chosen}
            if remove_at:
                new_ins: List[Any] = []
                for idx, ins in enumerate(instructions):
                    it = remove_at.get(idx)
                    if it is None:
                        new_ins.append(ins)
                    elif it.kind == "text":
                        new_ins.extend(_replacement(it, ins))
                    elif it.kind == "path":
                        new_ins.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("n")))
                page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(new_ins))
            if remove_at or patched:
                report["pages"].append(page_index)
            report["removed"] += len(remove_at)
            report["imagePatches"] += patched

        pdf.remove_unreferenced_resources()
        out = io.BytesIO()
        pdf.save(out, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
        return out.getvalue(), report
    finally:
        pdf.close()
