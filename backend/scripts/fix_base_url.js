const fs = require('fs');

const serviceFile = 'C:/Users/sathi/Desktop/projects/Master Code of Crm and APP/Traxen_App/TRACKSPHERE-app-main/lib/features/customer/features/dashcam/data/services/dashcam_api_service.dart';
if (fs.existsSync(serviceFile)) {
  let content = fs.readFileSync(serviceFile, 'utf8');
  content = content.replace("static const String _defaultBaseUrl = 'http://localhost:8798';", "static const String _defaultBaseUrl = 'http://163.128.112.26:9090';");
  fs.writeFileSync(serviceFile, content, 'utf8');
  console.log('Updated _defaultBaseUrl to http://163.128.112.26:9090');
}

const dialogFile = 'C:/Users/sathi/Desktop/projects/Master Code of Crm and APP/Traxen_App/TRACKSPHERE-app-main/lib/features/customer/features/dashcam/presentation/dialogs/server_config_dialog.dart';
if (fs.existsSync(dialogFile)) {
  let content = fs.readFileSync(dialogFile, 'utf8');
  content = content.replace("hintText: 'http://your-camera-vps-ip:8798'", "hintText: 'http://163.128.112.26:9090'");
  content = content.replace("• 8798: Web Streaming & REST API (HTTP/WS)", "• 9090: Web Streaming & REST API (HTTP/WS)");
  fs.writeFileSync(dialogFile, content, 'utf8');
  console.log('Updated server_config_dialog.dart');
}
