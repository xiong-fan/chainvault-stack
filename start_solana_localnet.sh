# ticks-per-slot 默认是 64，值越大出块越慢， 320 是 2 秒出块
# 适当放慢可方便查看调试日志
solana-test-validator \
    --ticks-per-slot 64 \
    --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s /Users/tangao/github_program/cex-wallet/metadata_latest.so