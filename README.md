## Installation

### Step 1: Install NodeJS

Node.js is a free, open-source, cross-platform JavaScript runtime environment.

[a] (Windows OS) Open the Terminal app by pressing the WINDOW button and then type 'cmd' and press Enter. The Terminal app should pop up.
   (Mac OS) Open the Terminal app from the launchpad.
[b] Type **node -v** and press Enter. If the console prints a message like 'v18.0.0' you're all set and jump to **Step 2**. If you get the message **'node' is not recognized as an internal or external command** you should proceed on the step c.
![](/howto/howto_nodev.png)
[c] Close the terminal window you opened on step a.
[d] Download and install NodeJs from [NodeJS Official website](https://nodejs.org/en/download/prebuilt-installer)
[e] Go back to step [a], open the Terminal app again and check if the NodeJS has been installed properly.


### Step 2: Download ZBTC Miner

[a] Download the open source ZBTC miner from this webpage. Click the highlighted "Code" button, then "Download ZIP".
![](/howto/howto_download.png)
[b] Once the download is finished, unzip the archive at your preferred location.
[c] Open the zbtc-miner-main folder, move the cursor to a blank area, hold down the Swift key and right click. From the drop down menu choose 'Open in Terminal' or 'Open PowerShell window here' (Note: If you don't have these options in the dropdown menu, be sure you right clicked on an empty area and no file is selected).
[d] In the Terminal window type **node run.js --test** to start a quick test. This will guide you to setup a wallet first. Follow the instructions to complete the setup process.


## Mining

> [!IMPORTANT]
> If you closed the terminal window from **Step 2**, open it again by following **Step 2[c]**

Type **node run.js --mine** to start mining.

> [!NOTE]
> Add the --threads argument to tell how many cpu threads will be fired up: **node run.js --mine --threads 2**

> [!NOTE]
> Add the --difficulty argument to set the mining difficulty: **node run.js --mine --difficulty 10**