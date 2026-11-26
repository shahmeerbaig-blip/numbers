function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Hybrid Fleet Expansion | Talabat')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
