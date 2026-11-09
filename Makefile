# Hachi Reader — 常用构建任务
BINARY := hachi
VERSION ?= 0.1.0
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build dev test test-live vet cross clean icons package-win32

all: build

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/hachi

# 前端从磁盘读取，改完刷新即可
dev:
	HACHI_DEV=1 go run ./cmd/hachi -addr :8080 -data ./data

test:
	go test ./...

# 联网集成测试（会真实请求 wenku8）
test-live:
	HACHI_LIVE=1 go test ./internal/wkk/ -run Live -v

vet:
	go vet ./...

# 交叉编译三平台
cross:
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-linux-amd64   ./cmd/hachi
	CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-linux-arm64   ./cmd/hachi
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-windows-amd64.exe ./cmd/hachi
	CGO_ENABLED=0 GOOS=windows GOARCH=386   go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-windows-386.exe ./cmd/hachi
	CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-darwin-arm64  ./cmd/hachi
	CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-darwin-amd64  ./cmd/hachi

# Windows 32 位分发包（exe + 中文说明 + 服务安装脚本）
package-win32:
	CGO_ENABLED=0 GOOS=windows GOARCH=386 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-windows-386.exe ./cmd/hachi
	rm -rf dist/pkg && mkdir -p dist/pkg
	cp dist/$(BINARY)-windows-386.exe dist/pkg/hachi.exe
	cp docs/WINDOWS.txt dist/pkg/README-Windows.txt
	cp deploy/install-windows.ps1 dist/pkg/
	cd dist/pkg && zip -r -9 ../$(BINARY)-windows-386.zip . >/dev/null && cd ../..
	rm -rf dist/pkg
	@echo "→ dist/$(BINARY)-windows-386.zip"

icons:
	python3 web/icons/gen_icons.py

clean:
	rm -rf dist $(BINARY)
