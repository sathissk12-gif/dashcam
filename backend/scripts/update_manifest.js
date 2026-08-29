const fs = require('fs');

const targetFile = 'C:/Users/sathi/Desktop/projects/Master Code of Crm and APP/Traxen_App/TRACKSPHERE-app-main/android/app/src/main/AndroidManifest.xml';

if (fs.existsSync(targetFile)) {
  let content = fs.readFileSync(targetFile, 'utf8');

  if (!content.includes('android.permission.RECORD_AUDIO')) {
    content = content.replace(
      '<uses-permission android:name="android.permission.INTERNET"/>',
      '<uses-permission android:name="android.permission.INTERNET"/>\n    <uses-permission android:name="android.permission.RECORD_AUDIO"/>\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>'
    );
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('Added RECORD_AUDIO permissions to AndroidManifest.xml');
  }
}
