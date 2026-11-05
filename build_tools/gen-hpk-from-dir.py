import os
import json
import zipfile
import base64

# A reliable base64-encoded template PNG icon (a clean default square icon)
DEFAULT_ICON_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwY"
    "AAAAB3RJTUUH5gYREy4K6Zl9VwAAAAlwSFlzAAALEgAACxIB0t1+/AAAAARnQU1BAACxjwv8"
    "YQUAAAAOSURBVHgB7Y5BDgAhCAMA//+0J7gS0+oDCSgNpx0m6yL8Z9g0qS2Bv4Yw8YgAAExV"
    "wACFzYgAAAAASUVORK5CYII="
)

def create_package():
    print("=== CAS App Manifest & Package Builder ===")
    
    manifest = {}
    
    # Common fields
    name = input("Enter app name (leave blank to omit): ").strip()
    if name:
        manifest["name"] = name
        
    desc = input("Enter app description / desc (leave blank to omit): ").strip()
    if desc:
        manifest["desc"] = desc
        
    app_type = input("Enter app type ('offline' or 'online'): ").strip().lower()
    if app_type:
        manifest["type"] = app_type
    else:
        app_type = "offline"
        manifest["type"] = app_type

    version = input("Enter version (e.g., 1.0.0, leave blank to omit): ").strip()
    if version:
        manifest["version"] = version

    # --- ONLINE APP HANDLING ---
    if app_type == "online":
        app_url = input("Enter the launch URL for this online app (leave blank to omit): ").strip()
        if app_url:
            manifest["url"] = app_url
            
        update_url = input("Enter updateUrl (leave blank to omit): ").strip()
        if update_url:
            manifest["updateUrl"] = update_url
            
        public_key = input("Enter publicKey (leave blank to omit): ").strip()
        if public_key:
            manifest["publicKey"] = public_key
            
        manifest_filename = "manifest.json"
        with open(manifest_filename, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            
        print(f"\n[Online App Mode]: No build or packaging required.")
        print(f"Successfully generated '{manifest_filename}' with your configuration!")
        return

    # --- OFFLINE APP HANDLING (.hpk Build Required) ---
    perms_input = input("Enter permissions (comma-separated, e.g., notif, filesystem, background_workers, leave blank to omit): ").strip()
    if perms_input:
        manifest["permissions"] = [p.strip() for p in perms_input.split(",") if p.strip()]
        
    bg_worker = input("Enter Background Worker script path inside archive (e.g., assets/sw.js, leave blank to omit): ").strip()
    if bg_worker:
        manifest["Background_Worker"] = bg_worker
        
    update_url = input("Enter updateUrl (leave blank to omit): ").strip()
    if update_url:
        manifest["updateUrl"] = update_url
        
    public_key = input("Enter publicKey (leave blank to omit): ").strip()
    if public_key:
        manifest["publicKey"] = public_key

    # Icon handling
    icon_path_input = input("Enter icon file path (leave blank or type 'none' to auto-generate template icon): ").strip()
    use_custom_icon = False
    if icon_path_input and icon_path_input.lower() != "none":
        if os.path.exists(icon_path_input):
            use_custom_icon = True
            manifest["icon"] = "icon.png"
            print(f" -> Using custom icon from: {icon_path_input}")
        else:
            print(f"\n[Warning]: Icon file '{icon_path_input}' not found. Falling back to auto-generated template icon.")
    
    if not use_custom_icon:
        manifest["icon"] = "icon.png"
        print(" -> Auto-generating template icon for /icon.png")

    hpk_name = input("Enter output .hpk filename (default: app.hpk): ").strip()
    if not hpk_name:
        hpk_name = "app.hpk"
    if not hpk_name.endswith(".hpk"):
        hpk_name += ".hpk"

    current_dir = os.getcwd()
    index_path = os.path.join(current_dir, "index.html")
    
    if not os.path.exists(index_path):
        print("\n[Error]: 'index.html' not found in the current directory! Offline .hpk apps require an index.html.")
        return

    manifest_filename = "manifest.json"
    manifest_path = os.path.join(current_dir, manifest_filename)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"\nCreating archive: {hpk_name}...")
    script_filename = os.path.basename(__file__)

    with zipfile.ZipFile(hpk_name, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # 1. Add index.html to root
        zipf.write(index_path, arcname="index.html")
        print(" -> Added to root: index.html")
        
        # 2. Add manifest.json to root
        zipf.write(manifest_path, arcname=manifest_filename)
        print(f" -> Added to root: {manifest_filename}")
        
        # 3. Add icon.png to root (/icon.png)
        if use_custom_icon:
            zipf.write(icon_path_input, arcname="icon.png")
            print(" -> Added to root (/icon.png): custom icon")
        else:
            # Write the auto-generated template icon bytes directly into the zip
            icon_bytes = base64.b64decode(DEFAULT_ICON_B64)
            zipf.writestr("icon.png", icon_bytes)
            print(" -> Added to root (/icon.png): auto-generated template icon")
        
        # 4. Package everything else into assets/
        for root, dirs, files in os.walk(current_dir):
            for file in files:
                full_path = os.path.join(root, file)
                rel_to_current = os.path.relpath(full_path, current_dir)
                
                if rel_to_current in ["index.html", manifest_filename, script_filename, hpk_name]:
                    continue
                if use_custom_icon and os.path.abspath(full_path) == os.path.abspath(icon_path_input):
                    continue
                if rel_to_current.startswith('.'):
                    continue
                    
                arc_path = os.path.join("assets", rel_to_current)
                zipf.write(full_path, arcname=arc_path)
                print(f" -> Added to assets/: {rel_to_current}")

    # Clean up local temp manifest
    if os.path.exists(manifest_path):
        os.remove(manifest_path)

    print(f"\nSuccess! Offline .hpk package created: {os.path.join(current_dir, hpk_name)}")

if __name__ == "__main__":
    create_package()