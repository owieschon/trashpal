export default [
  {
    test: {
      name: 'trashpal',
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      testTimeout: 20_000,
    },
  },
]
