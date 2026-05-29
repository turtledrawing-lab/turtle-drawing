# Turtle Drawing

**Architectural modeling for Mac.**
Easy 3D modeling tool

[![Latest Release](https://img.shields.io/github/v/release/turtledrawing-lab/turtle-drawing?include_prereleases&label=release)](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)]()

[**Download (Releases)**](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest)

English · [한국어](README.ko.md)

---

## ✨ Features

- Mesh-modeling compatibility in mind: import & edit **SketchUp (OBJ)** and **Rhino (3dm)** files
- **2D ↔ 3D**: draw faces with Line / Rectangle / Circle, then **Extrude (P)** to instantly go solid
- **Wall Tool**: walls with thickness & height in one go. Auto multi-layer (finish / insulation / structure)
- **Section Plane**: cut the model → auto hatch + section lines on the cut face
- **Layers (CAD-style)**: per-layer line weight (mm) + hatch pattern → drawing hierarchy in exports
- **Scenes**: save camera & section states, move smoothly between them
- **Entourage**: drag-place people / plants (PNG/SVG), custom uploads too
- **SVG / PNG export**: auto-labeling + scale settings

---

## 📦 Install

### Download
Grab the right `.dmg` for your Mac from the [Releases page](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest):
- **Apple Silicon (M1/M2/M3/M4)** → `arm64.dmg`
- **Intel Mac** → `x64.dmg`

### Install
1. Double-click the `.dmg`
2. Drag **Turtle Drawing.app** to **Applications**
3. Double-click from Applications

---

## 🚀 Quick Start

If it's your first time, open menu → **Help → Onboarding Tour**. Toby (🐢) walks you through the essentials step by step.

### Shortcuts (most used)

| Key | Tool |
|---|---|
| `L` | Line |
| `R` | Rectangle |
| `C` | Circle |
| `P` | Extrude (Push/Pull) |
| `M` | Move |
| `Q` | Rotate |
| `S` | Scale |
| `T` | Ruler |
| `Space` | Select ↔ tool toggle |
| `F` | Fit camera to selection |
| `Esc` | Cancel tool / deselect |
| `Cmd+S` | Save (.tt) |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |

### Mouse
- **Middle drag** — orbit
- **Shift + middle drag** — pan
- **Wheel** — zoom

---

## 📥 Importing SketchUp Files Perfectly (with materials)

To bring a SketchUp model in **with its materials/textures intact**, export to OBJ *with* materials, then import the whole folder.

### 1. Export OBJ from SketchUp
1. **File → Export → 3D Model...**
2. Set the format to **OBJ File (\*.obj)**
3. Click **Options...** → check **Export Texture Maps** ✅ (the key option that exports materials too)
4. Export. You'll get, in one folder:
   - `modelname.obj` — geometry (mesh)
   - `modelname.mtl` — material definitions
   - a texture-image folder (`.jpg` / `.png`, etc.)

### 2. Import into Turtle Drawing
- The **`.obj`, `.mtl`, and texture images must all stay in the same folder** for materials to link correctly.
- Menu → **File → Import → OBJ**, then select that **folder (or the `.obj` file)**.
- As long as the `.mtl` and textures sit next to the `.obj`, materials and textures are mapped automatically.

> 💡 **Tip**: If materials don't show up, make sure you didn't move the `.obj` away on its own. Always keep the `.obj` / `.mtl` / texture folder **together**. Groups/components from SketchUp are kept as blocks on import.

---

## 🛠️ System Requirements

- macOS 10.12 (Sierra) or later
- Apple Silicon or Intel Mac

---

## 📄 License

Currently alpha — free for personal use; commercial use / redistribution will be announced with the official license later.

---

<div align="center">

Made with 🐢 by **LIFE architects**

</div>
