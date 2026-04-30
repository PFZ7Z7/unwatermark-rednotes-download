# 小红书API逆向分析指南

## 方法一：浏览器开发者工具抓包

### 步骤：
1. 打开 Chrome 浏览器
2. 按 F12 打开开发者工具
3. 切换到 Network 标签
4. 访问小红书笔记页面
5. 筛选 XHR/Fetch 请求
6. 找到包含笔记数据的API请求

### 关键API：
- `https://edith.xiaohongshu.com/api/sns/web/v1/feed` - 获取笔记详情
- `https://www.xiaohongshu.com/api/sns/web/v2/note/feed` - 另一个笔记接口

### 需要关注的请求头：
```
x-s: 签名参数
x-t: 时间戳
x-s-common: 通用签名
cookie: 包含 a1, webId 等
```

## 方法二：使用现成的开源项目

GitHub上有一些已经逆向好的项目：

1. **MediaCrawler** - 支持小红书爬取
   https://github.com/NanmiCoder/MediaCrawler

2. **xhs** - 小红书爬虫
   https://github.com/ReaJason/xhs

## 方法三：使用第三方解析API

一些付费/免费的解析服务：
- 易解析
- 红薯库
- 各种API市场

## 下一步

你想用哪种方式？
1. 我帮你分析开源项目的代码，集成到我们的项目
2. 我帮你对接第三方API
3. 你自己抓包，告诉我API格式
