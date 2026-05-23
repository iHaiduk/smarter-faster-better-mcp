import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Глобально игнорируемые папки
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.scout-cache/**',
      '.history/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn', // предупреждение вместо ошибки на any
      'no-console': 'off', // в CLI-утилитах console.log разрешен
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  }
);
