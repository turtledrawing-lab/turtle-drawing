# 배포 서명·공증 가이드

## 개인 사용 (서명 없이)
```bash
npm install
npm start                 # 개발 실행
npm run build             # dist/Turtle Sketch-*.dmg 생성 (미서명)
```
첫 실행 시 macOS 게이트키퍼 경고가 뜨면 Finder에서 **우클릭 → 열기** 한 번만 허용하면 됩니다.

---

## 정식 서명 (Apple Developer 계정 필요, 연 $99)

### 1회 준비
1. [Apple Developer 계정](https://developer.apple.com/) 등록 후 Xcode에서 **Developer ID Application** 인증서 설치
2. [App Store Connect](https://appstoreconnect.apple.com/) → Users and Access → Keys → 앱 암호 생성 (공증용)

### 환경 변수
`.env.local` 같은 곳에 저장하고 빌드 전에 export 합니다.
```bash
export APPLE_ID="your@appleid.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"   # App-specific password
export APPLE_TEAM_ID="XXXXXXXXXX"                           # 10-char Team ID
export CSC_NAME="Developer ID Application: Your Name (XXXXXXXXXX)"
```

### package.json 수정
`build.mac` 아래에 두 줄을 바꾸고:
```json
"notarize": { "teamId": "XXXXXXXXXX" },
"identity": "Developer ID Application: Your Name (XXXXXXXXXX)"
```
그리고 `build.dmg.sign`도 `true`로.

### 빌드
```bash
npm run build:universal
```
`electron-builder`가 자동으로 서명 → Apple 서버로 공증 요청 → staple까지 수행합니다. 보통 3~10분.

---

## 자동 업데이트 게시

### 1회 준비
1. GitHub에 `turtle-sketch` 리포 생성 (비공개 가능)
2. `package.json`의 `publish.owner`를 본인 GitHub ID로 교체
3. Personal Access Token 생성 (repo 권한) 후 환경 변수:
```bash
export GH_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"
```

### 릴리스 게시
```bash
npm version patch         # 0.1.0 → 0.1.1
npm run publish
```
`dist/`의 `.dmg`, `.zip`, `latest-mac.yml`이 GitHub Releases에 드래프트로 업로드됩니다. GitHub에서 draft를 "Publish release"로 공개하면 기존 사용자 앱이 다음 실행 때 자동으로 감지하고, 백그라운드 다운로드 후 **"지금 재시작 / 나중에"** 다이얼로그를 띄웁니다.

---

## 아이콘 교체
`build/icon.svg`를 원하는 디자인으로 수정한 뒤:
```bash
npm run icon
```
더 빠른 렌더를 원하면 `brew install librsvg` (선택). 없으면 `qlmanage`+`sips` 조합으로 자동 폴백합니다.
