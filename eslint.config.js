import js from '@eslint/js'

/**
 * 两套运行环境，规则分开定义：
 *   Node 侧  —— 插件本体、锅巴注册、自检脚本（ESM）
 *   浏览器侧 —— guoba/dashboard.js。这文件是手写的 ES5，直接内联进状态页，
 *               所以保留 var / 函数声明风格，只查真正的错误（未定义变量、笔误）。
 */
export default [
  {
    ignores: ['node_modules/**', 'config/config.json'],
  },

  /* ---------- Node 侧 ---------- */
  {
    files: ['index.js', 'lib/**/*.js', 'guoba.support.js', 'guoba/index.js', 'test/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Yunzai 注入的全局
        logger: 'readonly',
        Bot: 'readonly',
        plugin: 'readonly',
        // 自检脚本里用到的
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // 这几条是「看起来能跑但早晚出事」的类型：=== 与变量声明
      eqeqeq: ['warn', 'smart'],
      'no-var': 'warn',
      'prefer-const': 'warn',
      // 代理代码里到处是 err.message 的兜底，允许空的 catch 由注释说明
      'no-console': 'off',
    },
  },

  /* ---------- 浏览器侧（guoba/dashboard.js） ---------- */
  {
    files: ['guoba/dashboard.js'],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        URLSearchParams: 'readonly',
        MutationObserver: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        confirm: 'readonly',
        console: 'readonly',
        // 确认条改成 Promise 之后要用到
        Promise: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // 这个文件按 ES5 写，var / 函数声明是刻意的
      'no-var': 'off',
      'prefer-const': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['warn', 'smart'],
    },
  },
]
