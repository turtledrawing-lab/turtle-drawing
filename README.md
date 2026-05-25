<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="build/turtle_white.png">
  <img src="build/turtle.png" width="220" alt="Turtle Drawing"/>
</picture>

# Turtle Drawing

**Architectural modeling for Mac.**
쉬운 3D 모델링 툴

[![Latest Release](https://img.shields.io/github/v/release/turtledrawing-lab/turtle-drawing?include_prereleases&label=release)](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)]()

[**다운로드 (Releases)**](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest)

</div>

---

## ✨ 주요 기능

- Sketchup(Obj), Rhino(3dm)의 메쉬 모델링 파일일 불러오고 수정이 가능하도록 호환성을 고려
- **2D ↔ 3D 통합**: Line / Rectangle / Circle 로 면을 그리고 **Extrude(P)** 로 즉시 입체화
- **벽 도구 (Wall Tool)**: 두께·높이가 있는 벽을 한 번에. 다층 구조(마감재/단열재/구조체) 자동 생성
- **단면 (Section Plane)**: 모델 자르기 → 자른 면에 **해치 + 단면선** 자동 생성
- **레이어 (CAD 스타일)**: 선두께(mm) + 해치 패턴 레이어별 지정 → 도면 출력에 위계 반영
- **씬 (Scenes)**: 카메라 위치·단면 상태를 저장하고 부드럽게 이동
- **엔투라지 (Entourage)**: 사람·식물 등 PNG/SVG 를 드래그로 배치 (커스텀 업로드도 가능)
- **SVG / PNG 내보내기**: 자동 라벨링 + 축척 설정

---

## 📦 설치

### 다운로드
[Releases 페이지](https://github.com/turtledrawing-lab/turtle-drawing/releases/latest) 에서 본인 Mac 에 맞는 `.dmg` 다운로드:
- **Apple Silicon (M1/M2/M3/M4)** → `arm64.dmg`
- **Intel Mac** → `x64.dmg`

### 설치
1. `.dmg` 더블클릭
2. **Turtle Drawing.app** 을 **Applications** 폴더로 드래그
3. Applications 에서 더블클릭

### 첫 실행 시 경고 (현재 알파 — 미서명 빌드)
> 정식 v1.0 부터는 Apple 공증이 적용되어 경고가 없어져요.

"확인되지 않은 개발자" 경고가 뜨면:
- **방법 1**: Applications 에서 앱을 **우클릭 → 열기** → 다시 "열기"
- **방법 2**: 터미널에 한 줄:
  ```
  xattr -dr com.apple.quarantine /Applications/Turtle\ Drawing.app
  ```

---

## 🚀 빠른 시작

처음이라면 메뉴바 → **Help → Onboarding Tour** 를 눌러봐. 토비(🐢)가 핵심 기능을 단계별로 안내해줘요.

### 단축키 (자주 쓰는 것)

| 키 | 도구 |
|---|---|
| `L` | Line |
| `R` | Rectangle |
| `C` | Circle |
| `P` | Extrude (Push/Pull) |
| `M` | Move |
| `Q` | Rotate |
| `S` | Scale |
| `T` | Ruler |
| `Space` | Select ↔ 도구 토글 |
| `F` | 선택 객체에 카메라 맞춤 |
| `Esc` | 도구 취소 / 선택 해제 |
| `Cmd+S` | 저장 (.tt) |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |

### 마우스 조작
- **가운데 드래그** — 회전 (orbit)
- **Shift + 가운데 드래그** — 패닝 (pan)
- **휠** — 줌

---

## 🛠️ 시스템 요구사항

- macOS 10.12 (Sierra) 이상
- Apple Silicon 또는 Intel Mac

---

## 📸 스크린샷

<img src="docs/screenshot-main.png" alt="Turtle Drawing main view"/>

---

## 🐞 버그 신고 & 기능 제안

[Issues](https://github.com/turtledrawing-lab/turtle-drawing/issues) 에 글 남겨주세요.

---

## 📄 라이선스

현재 알파 단계 — 개인 사용 자유, 상업 사용 / 재배포는 추후 정식 라이선스 발표 시 안내.

---

<div align="center">

Made with 🐢 by **turtledrawing-lab**

</div>
