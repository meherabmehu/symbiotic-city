"""
WCAG 2.1 contrast guard for the design tokens.

The palette is the product's entire readable surface, and a colour is easy to
nudge for aesthetic reasons without noticing that it took body text below the
AA threshold. That happened here: the two darkest ink steps were used for 10-11px
labels and reached 3.04:1 and 2.62:1 once a glass panel was composited over the
page background, where AA asks for 4.5:1 at those sizes.

This test recomputes the real composited surfaces from the tokens rather than
trusting a hand-written table, so the numbers cannot drift away from the design.

Run: .venv/bin/python -m pytest backend/tests/test_design_tokens.py
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

TAILWIND = Path(__file__).resolve().parents[2] / "frontend" / "tailwind.config.ts"


def _config() -> str:
    return TAILWIND.read_text()


def _block(name: str) -> str:
    """The body of a nested colour object, e.g. the inside of ``ink: { ... }``."""
    text = _config()
    start = re.search(rf"\b{re.escape(name)}:\s*{{", text)
    assert start, f"{name} block not found in tailwind.config.ts"
    depth = 0
    for i in range(start.end() - 1, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start.end() : i]
    raise AssertionError(f"unbalanced braces reading {name}")


def _read_token(name: str, scale: str | None = None) -> str:
    """A colour token, from a named scale or from the top level.

    Scale-qualified lookups matter: ``500`` exists in both ``navy`` and ``ink``,
    and resolving it by file order silently compares the wrong colour.
    """
    text = _block(scale) if scale else _config()
    match = re.search(rf'\b{re.escape(name)}:\s*"(#[0-9a-fA-F]{{6}})"', text)
    if match:
        return match.group(1)
    if name == "accent":
        default = re.search(r'\bDEFAULT:\s*"(#[0-9a-fA-F]{6})"', _block("accent"))
        if default:
            return default.group(1)
    where = f"{scale}.{name}" if scale else name
    raise AssertionError(f"token {where!r} not found in tailwind.config.ts")


def _rgb(hex_colour: str) -> tuple[int, int, int]:
    value = hex_colour.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def _luminance(rgb: tuple[int, int, int]) -> float:
    def channel(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = _luminance(a), _luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def _over(fg: tuple[int, int, int], alpha: float, bg: tuple[int, int, int]):
    return tuple(round(alpha * f + (1 - alpha) * b) for f, b in zip(fg, bg))


@pytest.fixture(scope="module")
def surfaces() -> dict[str, tuple[int, int, int]]:
    """The backgrounds text is actually painted on, composited as the browser does."""
    navy_950 = _rgb(_read_token("950", "navy"))
    navy_900 = _rgb(_read_token("900", "navy"))
    navy_850 = _rgb(_read_token("850", "navy"))
    glass = _over(navy_850, 0.70, navy_950)  # .glass = bg-navy-850/70 over the page
    return {
        "navy-950": navy_950,
        "navy-900": navy_900,
        "glass": glass,
        "glass + white/5": _over((255, 255, 255), 0.05, glass),
        "glass + white/10": _over((255, 255, 255), 0.10, glass),
    }


INK_STEPS = ["ink-50", "ink-100", "ink-200", "ink-300", "ink-400", "ink-500"]
SEMANTIC = ["accent", "mint", "amber", "coral"]


@pytest.mark.parametrize("token", INK_STEPS + SEMANTIC)
def test_every_text_token_clears_wcag_aa_on_every_surface(token, surfaces):
    """4.5:1 is the AA threshold for normal text, which is what these are used for.

    The tokens are deployed at 10-11px for labels, so the 3:1 large-text
    allowance does not apply.
    """
    if token.startswith("ink"):
        colour = _rgb(_read_token(token.split("-", 1)[1], "ink"))
    else:
        colour = _rgb(_read_token(token))
    for name, background in surfaces.items():
        ratio = _contrast(colour, background)
        assert ratio >= 4.5, (
            f"{token} reaches only {ratio:.2f}:1 on {name}; "
            "WCAG AA needs 4.5:1 for body text"
        )


def test_ink_scale_stays_monotonic():
    """50 is the lightest step and 500 the darkest; a non-monotonic scale means a
    shade was edited in isolation."""
    luminances = [_luminance(_rgb(_read_token(s.split("-", 1)[1], "ink"))) for s in INK_STEPS]
    assert luminances == sorted(luminances, reverse=True), (
        f"ink scale is not ordered light->dark: {[round(x, 3) for x in luminances]}"
    )


def test_chart_axis_colours_match_the_tokens():
    """Chart ticks are 9-10px, so the hardcoded hexes must be AA-clearing ones.

    The old axis colours (#4d6d8f, #8fb3d4) were the pre-fix ink steps and failed
    on a raised glass row.
    """
    charts = (TAILWIND.parent / "components" / "charts.tsx").read_text()
    code = re.sub(r"//[^\n]*", "", charts)  # comments may name the old colours
    for stale in ("#4d6d8f", "#6b8fb3", "#b9d2ea"):
        assert stale not in code, f"charts.tsx still hardcodes the failing colour {stale}"
