# Facade Generator (입면 제너레이터)

사례 이미지/도면 → 파라미터(스키마) → 파라메트릭 지오메트리 생성.
핵심 원칙: **AI는 파라미터만 추출하고, 지오메트리는 결정론적 제너레이터(ad/facade_gen.js)가 만든다.**

## 로드맵

- **P0 (this)**: 스키마 + 제너레이터 2종(루버, 커튼월) + 면 선택 → 생성 UI. AI 없음(수동 파라미터).
- P1: 이미지 드롭 → Claude 비전 → 스키마 자동 채움 (데스크톱 먼저; 웹은 프록시 필요).
- P2: confidence 표시 + 실시간 프리뷰 재생성 패널.
- P3: 아키타입 확장(브리즈솔레이유, 패널 클래딩, 펀치드 윈도우, 랜덤 패턴), 도면 치수 읽기, 커스텀 단면 폴리라인.

## 단위

스키마의 모든 길이는 **mm**. 제너레이터가 내부 월드 단위로 변환한다
(변환 계수는 ad/facade_gen.js의 `MM` 상수 한 곳에만 존재).

## 스키마 v1

공통 envelope:

```json
{
  "version": 1,
  "archetype": "louver" | "curtain_wall",
  "name": "남측 루버",            // 생성될 그룹 이름 (기본값: 아키타입명)
  "params": { ... }               // 아키타입별
}
```

### archetype: "louver"

```json
{
  "orientation": "vertical" | "horizontal",
  "spacing": 600,                  // 날개 중심 간격 mm
  "profile": {
    "shape": "rect" | "ellipse" | "L" | "Z" | "airfoil",
    "w": 40,                       // 날개 두께(면과 평행 방향) mm
    "d": 150                       // 날개 깊이(면 법선 방향) mm
  },
  "rotation_deg": 0,               // 날개 각도(0 = 면에 수직으로 세움), 프로파일 중심 기준 회전
  "offset": 100,                   // 면에서 날개 뒷면(가까운 쪽)까지 이탈거리 mm
  "inset": 0,                      // 면 경계에서 안쪽 여백 mm (상하좌우 공통)
  "support": {
    "type": "none" | "top_bottom_rail" | "side_rail",
    "rail_w": 60, "rail_d": 60     // 레일 단면 mm
  }
}
```

생성 결과: 그룹 `{name}` ─ 내부에 날개 = **컴포넌트 인스턴스**(프로파일 definition 1개 + N 인스턴스),
레일은 일반 오브젝트. 날개 길이는 면 경계(inset 적용)에 맞춤.

### archetype: "curtain_wall"

```json
{
  "grid": {
    "u_pitch": 1200,               // 수평 분할 피치 mm (u = 면의 가로축)
    "v_pitch": 3500,               // 수직 분할 피치 mm
    "align": "start" | "center"    // 남는 치수 처리(가장자리 몰림 vs 중앙정렬)
  },
  "mullion": { "w": 50, "d": 150 },   // 수직 멀리언 단면 mm (w=면과 평행, d=법선 깊이)
  "transom": { "w": 50, "d": 150 },   // 수평 트랜섬 단면
  "glass": {
    "thickness": 24,
    "inset_from_front": 50          // 프레임 앞면(멀리언/트랜섬 중 깊은 쪽)에서 유리까지 후퇴 mm
  },
  "spandrel": {
    "every_v": 0,                   // n행마다 스팬드럴(0 = 없음)
    "height": 900                   // 스팬드럴 높이 mm (해당 행 하단)
  },
  "offset": 0                       // 면에서 시스템 뒷면까지 mm
}
```

생성 결과: 그룹 `{name}` ─ 멀리언/트랜섬 = 컴포넌트 인스턴스(단면별 def), 유리 = 반투명 패널 인스턴스.

## 면 → UV 배치 규칙

- 대상: 사용자가 클릭한 **평면 영역**(코플래너 삼각형 묶음)의 월드 경계 루프.
- 기저: `n` = 면 법선, `v` = 월드 Y(위쪽)를 면에 투영, 퇴화 시(수평면) 월드 ±Z 사용, `u = v × n`. (씬은 Y-up)
- P0 배치 영역 = 경계 루프의 **UV bounding box** (비사각형 면은 P3에서 클리핑).
- 생성물은 면 밖 `offset` 방향(법선 +)으로 돌출.

## 열기

메뉴/패널: 도구 패널의 "입면" 버튼 → 다이얼로그(아키타입 탭 + 파라미터 폼 + [면 선택 후 생성]).
콘솔: `AD.Facade.generate(schemaJson, pickedFace)` — P1에서 AI가 채운 JSON도 같은 입구로 들어온다.
