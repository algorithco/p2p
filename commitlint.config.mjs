export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Dependabot bodies embed upstream changelog URLs (long lines) that can
    // never satisfy body-max-line-length. Subject rules still apply, so
    // human commit hygiene is unaffected. Actor-independent: also covers
    // bot branches a human has touched (where the ci.yml actor-skip can't).
    'body-max-line-length': [0, 'always', Infinity],
  },
};
