# Neo QC - PC Service & Quality Control Portal
### Developed for Neo Tokyo Kochi Service Department

**Neo QC** is a native Windows desktop application designed to streamline the PC assembly, service, and diagnostic verification workflow. It helps technicians keep build tracking transparent and automatically extracts hardware specifications, thermal logs, and benchmark scores from local test files.

---

## 1. How to Run & Build the Software

### Prerequisites
1. Install **Node.js** (LTS version recommended) on the development PC.
2. In this project folder (`c:\Users\Rony Thomas\Desktop\Aladeen`), double-click or run PowerShell and install dependencies:
   ```bash
   npm install
   ```

### Running in Development (Staff or Client Mode)
To launch the app window locally to view or test it:
```bash
npm start
```

### Compiling to a Standalone Windows Executable (.exe)
To package the app into a single, portable Windows program that you can put on a USB stick or distribute to your shop PCs:
```bash
npm run build
```
Once completed, the compiled executable will be located in the `dist/` directory as a portable `.exe` file (e.g., `NeoQC.exe`).

---

## 2. Setting Up the Free Cloud Database (Supabase Sync)

To keep multiple computers in your shop synchronized so everyone can see ticket updates in real time:

1. Create a free account at [Supabase](https://supabase.com).
2. Create a new project named **Neo QC**.
3. Open the **SQL Editor** in the Supabase sidebar.
4. Open the [database.sql](file:///c:/Users/Rony%20Thomas/Desktop/Aladeen/database.sql) file from this folder, copy its contents, paste them into the Supabase SQL editor, and click **Run**.
5. Go to your Supabase **Project Settings -> API** and copy:
   - **Project URL**
   - **anon / public API Key**
6. Open **Neo QC** (in Staff Mode), click **⚙️ Settings**, paste these two values under the Supabase section, and click **Save Settings**.
7. All tickets will now sync automatically across all systems connected to this database!

---

## 3. How to Use the Testing Client on Newly Built PCs

When launching the app on a PC you just built, select **Testing Client**.

### Step A: Auto-Detect System Specs
Click **Auto-Detect System Specs**. The app will run Powershell commands in the background to automatically identify the CPU model, GPU model, RAM capacity, and primary SSD model.

### Step B: Auto-Verify Windows License
Click **Check Windows Activation State**. The app will query Windows natively to confirm if the OS license is valid, automatically updating the checkbox.

### Step C: Auto-Import HWiNFO64 Temperatures
1. Open **HWiNFO64** on the testing system.
2. Click the **Sensors** button.
3. At the bottom right of the Sensors screen, click the **Logging Start** button (the green sheet icon with a plus sign) and select where to save the `.csv` file.
4. Run your thermal stress test (e.g., FurMark/Cinebench) for a few minutes.
5. Click **Logging Stop** in HWiNFO64.
6. In **Neo QC**, click **Select CSV Log** and select the file. The app will instantly extract and display the Min, Max, and Average temperatures for both CPU and GPU.

### Step D: Auto-Import Cinebench Scores
1. Run a benchmark in **Cinebench**.
2. Click **File -> Save Searchable/TXT Log** or copy/paste the score.
3. Select the file in **Neo QC** to automatically load the score.

### Step E: Auto-Import SSD Speed Benchmarks
1. Run a test in **CrystalDiskMark**.
2. Go to **File -> Save Test Result (TXT)**.
3. Select that TXT file in **Neo QC** to automatically grab the Sequential Read and Write speeds.

Once these files are loaded, click **Upload Results to Ticket & Sync** to push the data directly to the database.

---

## 4. Troubleshooting & Offline Mode

- **What if the target PC has no internet connection?**
  If there is no network driver installed yet, you can run the app offline. Click **Export Offline Config File (.json)** in the client app. This saves the log to your USB drive. Plug the USB into a Staff PC, edit that ticket, and the data will be read and saved.
- **Where is data saved locally?**
  All local logs are saved on the computer's hard drive at:
  `%APPDATA%/Neo-QC/database/db.json`
