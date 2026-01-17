import os

patterns = {
    "BentoPDF": "ChamPDF",
    "bentopdf": "champdf",
    "bento-pdf": "cham-pdf",
    "Bento PDF": "ChamPDF"
}

excluded_dirs = {".git", "node_modules", "vendor", "dist"}

def replace_in_file(file_path):
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        new_content = content
        for search, replace in patterns.items():
            new_content = new_content.replace(search, replace)
        
        if new_content != content:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"Updated: {file_path}")
    except Exception as e:
        print(f"Error processing {file_path}: {e}")

for root, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in excluded_dirs]
    for file in files:
        if file.endswith((".html", ".json", ".ts", ".js", ".md", ".yml", ".yaml", ".mjs", ".xml")):
            file_path = os.path.join(root, file)
            replace_in_file(file_path)
