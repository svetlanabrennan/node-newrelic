SET NEW_RELIC_FOLDER="%HOME%\node_modules/newrelic"
IF EXIST %NEW_RELIC_FOLDER% (
  npm uninstall newrelic
)
