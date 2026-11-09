# Hachi Reader — 常用构建任务
BINARY := hachi
VERSION ?= 0.1.0
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build dev test test-live vet cross clean icons

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
	CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-darwin-arm64  ./cmd/hachi
	CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/$(BINARY)-darwin-amd64  ./cmd/hachi

icons:
	python3 web/icons/gen_icons.py

clean:
	rm -rf dist $(BINARY)
