const fs = require('fs');

const targetFile = 'C:/Users/sathi/Desktop/projects/Master Code of Crm and APP/Traxen_App/TRACKSPHERE-app-main/lib/features/customer/features/dashcam/presentation/pages/dashcam_live_studio_page.dart';

if (fs.existsSync(targetFile)) {
  let code = fs.readFileSync(targetFile, 'utf8');

  // Ensure default layout is 1 (Front Camera)
  code = code.replace('int _selectedLayout = 2;', 'int _selectedLayout = 1;');

  fs.writeFileSync(targetFile, code, 'utf8');
  console.log('Updated dashcam_live_studio_page.dart layout default to Front Camera');
}
