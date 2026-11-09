FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# 只读题库/材料/派生索引（体积大、变化少，放最前以命中构建缓存）
COPY tiku.db materials.db tiku-index.db ./
# 运行时代码（零依赖，无需 npm install）
COPY server.mjs adduser.mjs ./
COPY lib ./lib
COPY public ./public

# practice.db、ai-config.db 运行时生成，不打包进镜像
EXPOSE 3000
CMD ["node", "server.mjs", "3000"]
