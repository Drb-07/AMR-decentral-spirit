import asyncio
import json
from playwright.async_api import async_playwright

async def run_test(mode="claims", seed=42, duration=300):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Navigate to headless endpoint
        url = f"http://localhost:8000/?headless=1&seed={seed}&bots=8&duration={duration}"
        await page.goto(url)
        
        # Inject mode and force simulation to run 10x faster
        await page.evaluate(f"window.TRAFFIC_MODE = '{mode}'; window.simSpeed = 10;")
        
        # Wait for simulation duration to complete (timeout=0 disables the timeout limit entirely)
        print(f"Running mode={mode} seed={seed} for {duration} sim-sec...")
        await page.wait_for_function(f"typeof totalSimSeconds !== 'undefined' && totalSimSeconds >= {duration}", timeout=0)
        
        # Extract telemetry
        bench_result = await page.evaluate("window.__bench()")
        print(f"Results for [{mode.upper()}]:")
        print(json.dumps(bench_result, indent=2))
        
        await browser.close()
        return bench_result

if __name__ == "__main__":
    asyncio.run(run_test(mode="claims", seed=42, duration=300))
    asyncio.run(run_test(mode="baseline", seed=42, duration=300))