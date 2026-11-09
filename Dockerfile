#
# Hachi Reader — 生产镜像
#
# 前端是「无构建步骤」的原生 ES 模块，由 Go 通过 embed 打进二进制，
# 所以运行镜像里不需要 web/ 目录，也不需要 Node.js。
#
# 构建：
#   docker build -t hachi-reader:local .
#   docker build -t hachi-reader:0.1.0 --build-arg VERSION=0.1.0 .
#
# 运行：
#   docker run -d --name hachi -p 127.0.0.1:8080:8080 \
#     -v hachi-data:/data --restart unless-stopped hachi-reader:local

# ---------- 构建阶段 ----------
FROM golang:1.27-alpine AS build

WORKDIR /src

# alpine 镜像很干净：补上 ca-certificates 与 git（go mod 拉 VCS 依赖时需要）
RUN apk add --no-cache ca-certificates git

ENV CGO_ENABLED=0 \
    GOOS=linux

# 先复制依赖清单，让 go mod download 这一层可以命中缓存
COPY go.mod go.sum ./
RUN go mod download

# 再复制源码（.dockerignore 已排除 .git、部署脚本与本地构建产物）
COPY . .

ARG VERSION=dev
RUN go build \
      -trimpath \
      -buildvcs=false \
      -ldflags="-s -w -X main.version=${VERSION}" \
      -o /out/hachi ./cmd/hachi

# ---------- 运行阶段 ----------
# 选 alpine 而不是 distroless：需要 busybox 的 wget 做 HEALTHCHECK，
# 也保留 sh 便于排障；ca-certificates + tzdata 是抓取 wenku8 与统计日期的必需品。
FROM alpine:3.22 AS runtime

LABEL org.opencontainers.image.title="Hachi Reader" \
      org.opencontainers.image.description="自托管的 wenku8 轻小说 PWA 阅读器"

RUN apk add --no-cache ca-certificates tzdata \
 && addgroup -S -g 10001 hachi \
 && adduser -S -D -H -u 10001 -G hachi hachi \
 && mkdir -p /data \
 && chown -R hachi:hachi /data

ENV HACHI_ADDR=:8080 \
    HACHI_DATA=/data \
    TZ=Asia/Shanghai

COPY --from=build /out/hachi /usr/local/bin/hachi

USER hachi
WORKDIR /data

# 数据目录：SQLite / 抓取缓存 / 图片落盘都在这里
VOLUME ["/data"]

EXPOSE 8080

# 注意：healthcheck 固定打 8080；若覆盖 HACHI_ADDR 端口，需同时覆盖 --health-cmd
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/hachi"]
