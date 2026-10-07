(function (root) {
  'use strict';
  var system = matchMedia('(prefers-color-scheme: dark)');
  var preference = 'auto';
  try { preference = localStorage.getItem('probabilitylab.theme') || 'auto'; } catch (_) {}
  if (['auto', 'light', 'dark'].indexOf(preference) < 0) preference = 'auto';
  function apply() {
    var theme = preference === 'auto' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    var selector = document.getElementById('theme-select');
    if (selector) selector.value = preference;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#060f16' : '#f5f5ef';
    document.dispatchEvent(new Event('probabilitylab:appearance'));
  }
  root.ProbabilityAppearance = {
    getPreference: function () { return preference; },
    getTheme: function () { return document.documentElement.dataset.theme; },
    setTheme: function (value) {
      if (['auto', 'light', 'dark'].indexOf(value) < 0) throw new RangeError('Invalid theme');
      preference = value;
      try { localStorage.setItem('probabilitylab.theme', value); } catch (_) {}
      apply();
    }
  };
  system.addEventListener('change', function () { if (preference === 'auto') apply(); });
  apply();
}(window));
