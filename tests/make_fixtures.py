"""Build DICOM fixtures that look like real OCT exports, with all the identifying
tags the de-identification module has to remove."""
import numpy as np
from PIL import Image, ImageDraw
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid
import os

os.makedirs("fixtures", exist_ok=True)
H, W = 496, 512


def bscan(seed=0, burn_in=None):
    r = np.random.default_rng(seed)
    img = np.zeros((H, W), dtype=np.float64)
    x = np.arange(W)
    fx = W * r.uniform(.42, .58)
    d = (x - fx) / (W * .085)
    pit = 90 * np.exp(-d * d)
    top = 170 + pit * .95 + 8 * np.sin(x * .006)
    for i, (off, th, b) in enumerate([(0,10,.78),(10,22,.30),(32,26,.62),(58,30,.22),
                                      (88,26,.50),(114,22,.20),(136,12,.92),(148,14,1.0)]):
        shrink = pit * max(0., .95 - i * .19) if i < 5 else 0.
        for k in range(th):
            yy = np.clip((top + off + k - shrink).astype(int), 0, H - 1)
            img[yy, x] = np.maximum(img[yy, x], b * (.8 + .4 * r.random(W)))
    img += r.normal(0, .08, img.shape)
    arr = (np.clip(img, 0, 1) * 4095).astype(np.uint16)

    if burn_in:                      # simulate an OCT export with the name rendered in
        im = Image.fromarray((arr / 16).astype(np.uint8))
        dr = ImageDraw.Draw(im)
        dr.text((8, 6), burn_in, fill=255)
        dr.text((8, H - 18), "MRN 8842119  DOB 12/03/1954", fill=255)
        arr = (np.asarray(im).astype(np.uint16)) * 16
    return arr


def make(path, name, pid, dob, sex, laterality, seed, burn_in=None, ann_tag=None):
    ds = Dataset()
    # --- the eleven identifiers the brief says to strip ---
    ds.PatientName            = name                 # (0010,0010)
    ds.PatientID              = pid                  # (0010,0020)
    ds.PatientBirthDate       = dob                  # (0010,0030)
    ds.PatientSex             = sex                  # (0010,0040)
    ds.AccessionNumber        = "ACC-99213"          # (0008,0050)
    ds.InstitutionName        = "Westmead Eyecare"   # (0008,0080)
    ds.ReferringPhysicianName = "Dr^Priya^Raman"     # (0008,0090)
    ds.OperatorsName          = "S^Nguyen"           # (0008,1070)
    ds.DeviceSerialNumber     = "SPEC-77341"         # (0018,1000)
    ds.OtherPatientIDs        = "AUX-5521"           # (0010,1000)
    ds.PatientTelephoneNumbers = "+61 2 9845 0000"   # (0010,2154)
    # extra identifiers that also should not survive
    ds.PatientAddress         = "14 Hawkesbury Rd, Westmead NSW"
    ds.StudyDate              = "20260714"
    ds.StudyTime              = "143207"

    # --- clinical content that MUST survive ---
    ds.Laterality             = laterality           # (0020,0060)
    ds.PixelSpacing           = [0.00387, 0.01144]
    ds.SliceThickness         = 0.0039
    ds.Modality               = "OPT"                # ophthalmic tomography
    ds.Manufacturer           = "Heidelberg Engineering"
    ds.ManufacturerModelName  = "SPECTRALIS"
    ds.StudyInstanceUID       = generate_uid()
    ds.SeriesInstanceUID      = generate_uid()
    ds.SOPInstanceUID         = generate_uid()
    ds.SOPClassUID            = "1.2.840.10008.5.1.4.1.1.77.1.5.4"
    if ann_tag is not None:
        ds.BurnedInAnnotation = ann_tag              # (0028,0301)

    arr = bscan(seed, burn_in)
    ds.Rows, ds.Columns = arr.shape
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 12, 11
    ds.PixelRepresentation = 0
    ds.PixelData = arr.tobytes()

    fm = FileMetaDataset()
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.ImplementationClassUID = generate_uid()
    ds.file_meta = fm
    ds.is_little_endian, ds.is_implicit_VR = True, False
    ds.save_as(path, enforce_file_format=True)
    print(f"  {path}  ({os.path.getsize(path)/1024:.0f} KB)")


print("fixtures:")
make("fixtures/clean_od.dcm",  "RAMAN^ANJALI", "WE-40182", "19580214", "F", "R", 1)
make("fixtures/clean_os.dcm",  "NGUYEN^MINH",  "WE-40183", "19710903", "M", "L", 2)
make("fixtures/burned_in.dcm", "OKAFOR^CHIDI", "WE-40184", "19540312", "M", "R", 3,
     burn_in="OKAFOR, CHIDI", ann_tag=None)          # tag ABSENT but text present
make("fixtures/annotated.dcm", "SMITH^JOHN",   "WE-40185", "19601122", "M", "L", 4,
     burn_in="SMITH, JOHN", ann_tag="YES")           # tag correctly set
print("done")
